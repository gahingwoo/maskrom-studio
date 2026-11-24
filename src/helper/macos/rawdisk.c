/*
 * maskrom-studio-rawdisk: write an image to a raw disk on macOS and read it
 * back, without running as root.
 *
 *   maskrom-studio-rawdisk /dev/rdiskN SIZE [PROMPT]
 *
 * stdin   SIZE bytes of image data
 * stdout  the same SIZE bytes, read back from the disk after writing
 * stderr  "opened BLOCKSIZE DISKSIZE", then "written", one per line, and
 *         any error message
 *
 * The disk is opened by Apple's /usr/libexec/authopen, which is allowed to
 * open raw disks once the user has granted the right
 * sys.openfile.readwrite.<device> in the system's password dialog (the same
 * way Raspberry Pi Imager and Armbian Imager do it). This program asks for
 * that right, starts authopen with it and receives the open file descriptor
 * over a socket. It then holds a descriptor for that one disk and nothing
 * else: it never has administrator rights itself. One descriptor, opened
 * for reading and writing, serves the write and the read-back, so the user
 * is asked once.
 *
 * A raw disk only takes whole blocks. The data is collected into 1 MiB
 * pieces, and the last piece is filled with zeros up to the next block
 * boundary.
 *
 * Exit status: 0 done, 2 bad arguments, 3 the right was not granted,
 * 4 the disk could not be opened, 5 write error, 6 read error, 7 the image
 * data ended early (or, with --regions, was not as described below), 8 the
 * disk is smaller than the image.
 *
 *   maskrom-studio-rawdisk --regions /dev/rdiskN END [PROMPT]
 *
 * Writes pieces at given places instead of one image from the start (the
 * staged Windows layout on an SD card or NVMe drive, src/woa/stage-layout.ts):
 *
 * stdin   for each region a header of two little-endian 64-bit numbers,
 *         its byte offset on the disk and its length, then that many bytes;
 *         a header with length 0 ends the list. Offsets and lengths are
 *         whole blocks, no region ends past END, and END must fit the disk
 *         (checked before anything is written).
 * stdout  after all are written, every region read back from the disk, in
 *         the same order, without headers
 * stderr  as above
 *
 * Written for Maskrom Studio; GPL-2.0-only like the rest of it.
 */

#include <Security/Authorization.h>
#include <Security/AuthorizationTags.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/disk.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define AUTHOPEN "/usr/libexec/authopen"
#define CHUNK ((size_t)1 << 20)
/* More than the staged layout ever has (WinPE's used ranges, the image, two tables). */
#define MAX_REGIONS 65536

enum {
	EXIT_ARGS = 2,
	EXIT_AUTH = 3,
	EXIT_OPEN = 4,
	EXIT_WRITE = 5,
	EXIT_READ = 6,
	EXIT_INPUT = 7,
	EXIT_SMALL = 8,
};

/* Only whole raw disks: /dev/rdisk followed by digits. */
static int valid_device(const char *s)
{
	static const char prefix[] = "/dev/rdisk";
	size_t n = sizeof(prefix) - 1;

	if (strncmp(s, prefix, n) != 0 || s[n] == '\0')
		return 0;
	for (s += n; *s; s++)
		if (*s < '0' || *s > '9')
			return 0;
	return 1;
}

/* Read until count bytes have arrived or the input ends. */
static ssize_t read_full(int fd, unsigned char *buf, size_t count)
{
	size_t done = 0;

	while (done < count) {
		ssize_t n = read(fd, buf + done, count - done);

		if (n < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (n == 0)
			break;
		done += (size_t)n;
	}
	return (ssize_t)done;
}

static int write_full(int fd, const unsigned char *buf, size_t count)
{
	size_t done = 0;

	while (done < count) {
		ssize_t n = write(fd, buf + done, count - done);

		if (n < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (n == 0) {
			errno = EIO;
			return -1;
		}
		done += (size_t)n;
	}
	return 0;
}

/*
 * Ask for the right to open the device for reading and writing. macOS shows
 * its password dialog (or Touch ID) unless the right is already held.
 */
static int authorize(const char *device, const char *prompt, AuthorizationExternalForm *ext)
{
	char right[256];
	AuthorizationRef ref = NULL;
	AuthorizationItem item = { right, 0, NULL, 0 };
	AuthorizationRights rights = { 1, &item };
	AuthorizationItem env_item = { kAuthorizationEnvironmentPrompt, 0, NULL, 0 };
	AuthorizationEnvironment env = { 0, &env_item };
	AuthorizationFlags flags = kAuthorizationFlagInteractionAllowed |
		kAuthorizationFlagExtendRights | kAuthorizationFlagPreAuthorize;
	OSStatus st;

	if (snprintf(right, sizeof(right), "sys.openfile.readwrite.%s", device) >= (int)sizeof(right))
		return EXIT_ARGS;
	if (prompt && *prompt) {
		env_item.valueLength = strlen(prompt);
		env_item.value = (void *)prompt;
		env.count = 1;
	}
	st = AuthorizationCreate(&rights, &env, flags, &ref);
	if (st != errAuthorizationSuccess) {
		fprintf(stderr, "authorization for %s not granted (%s, status %d)\n", right,
			st == errAuthorizationCanceled ? "cancelled" :
			st == errAuthorizationDenied ? "denied" :
			st == errAuthorizationInteractionNotAllowed ? "no dialog possible" : "error",
			(int)st);
		return EXIT_AUTH;
	}
	st = AuthorizationMakeExternalForm(ref, ext);
	if (st != errAuthorizationSuccess) {
		fprintf(stderr, "AuthorizationMakeExternalForm: status %d\n", (int)st);
		AuthorizationFree(ref, kAuthorizationFlagDestroyRights);
		return EXIT_AUTH;
	}
	/*
	 * The reference is kept until this process ends: authopen looks the
	 * right up through the external form.
	 */
	return 0;
}

/*
 * Start authopen with the authorization and take the descriptor it sends
 * back. Returns the descriptor, or -1.
 */
static int open_with_authopen(const char *device, const AuthorizationExternalForm *ext)
{
	int sock[2], in[2], fd = -1, status = 0;
	char flags[16];
	pid_t pid;
	struct msghdr msg;
	struct iovec iov;
	struct cmsghdr *c;
	char data[64];
	union {
		struct cmsghdr align;
		char buf[CMSG_SPACE(sizeof(int))];
	} control;
	ssize_t n;

	snprintf(flags, sizeof(flags), "%d", O_RDWR);
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, sock) != 0 || pipe(in) != 0) {
		perror("socketpair/pipe");
		return -1;
	}
	pid = fork();
	if (pid < 0) {
		perror("fork");
		return -1;
	}
	if (pid == 0) {
		dup2(in[0], STDIN_FILENO);
		dup2(sock[1], STDOUT_FILENO);
		close(in[0]);
		close(in[1]);
		close(sock[0]);
		close(sock[1]);
		execl(AUTHOPEN, AUTHOPEN, "-stdoutpipe", "-extauth", "-o", flags, device, (char *)NULL);
		perror(AUTHOPEN);
		_exit(127);
	}
	close(in[0]);
	close(sock[1]);
	if (write_full(in[1], (const unsigned char *)ext->bytes, sizeof(ext->bytes)) != 0)
		perror("passing the authorization to authopen");
	close(in[1]);

	memset(&msg, 0, sizeof(msg));
	memset(&control, 0, sizeof(control));
	iov.iov_base = data;
	iov.iov_len = sizeof(data);
	msg.msg_iov = &iov;
	msg.msg_iovlen = 1;
	msg.msg_control = control.buf;
	msg.msg_controllen = sizeof(control.buf);
	do {
		n = recvmsg(sock[0], &msg, 0);
	} while (n < 0 && errno == EINTR);
	if (n < 0)
		perror("recvmsg from authopen");
	else
		for (c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
			if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS &&
			    c->cmsg_len >= CMSG_LEN(sizeof(int)))
				memcpy(&fd, CMSG_DATA(c), sizeof(fd));
	close(sock[0]);
	while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
		;
	if (fd < 0)
		fprintf(stderr, "authopen did not open %s (wait status %d)\n", device, status);
	return fd;
}

struct region {
	unsigned long long offset, length;
};

static unsigned long long le64(const unsigned char *b)
{
	unsigned long long v = 0;
	int i;

	for (i = 7; i >= 0; i--)
		v = (v << 8) | b[i];
	return v;
}

/*
 * --regions: read the regions from stdin and write each where it belongs,
 * then read them all back to stdout.
 */
static int write_regions(int fd, uint32_t block, unsigned long long end, unsigned char *buf)
{
	struct region *list = NULL;
	size_t count = 0, i;
	unsigned long long left;
	unsigned char head[16];

	for (;;) {
		struct region r;
		ssize_t got = read_full(STDIN_FILENO, head, sizeof(head));

		if (got != (ssize_t)sizeof(head)) {
			fprintf(stderr, "the region list ended early, after %zu regions\n", count);
			return EXIT_INPUT;
		}
		r.offset = le64(head);
		r.length = le64(head + 8);
		if (r.length == 0)
			break;
		if (r.offset % block || r.length % block || r.offset > end || r.length > end - r.offset) {
			fprintf(stderr, "region %zu (offset %llu, length %llu) is not whole blocks of %u inside %llu bytes\n",
				count, r.offset, r.length, (unsigned)block, end);
			return EXIT_INPUT;
		}
		if (count == MAX_REGIONS) {
			fprintf(stderr, "more than %d regions\n", MAX_REGIONS);
			return EXIT_INPUT;
		}
		if (count % 256 == 0) {
			struct region *more = realloc(list, (count + 256) * sizeof(*list));

			if (!more) {
				fprintf(stderr, "out of memory\n");
				return EXIT_INPUT;
			}
			list = more;
		}
		list[count++] = r;
		if (lseek(fd, (off_t)r.offset, SEEK_SET) != (off_t)r.offset) {
			fprintf(stderr, "seek to byte %llu: %s\n", r.offset, strerror(errno));
			return EXIT_WRITE;
		}
		for (left = r.length; left > 0;) {
			size_t want = left < CHUNK ? (size_t)left : CHUNK;

			got = read_full(STDIN_FILENO, buf, want);
			if (got < 0 || (size_t)got < want) {
				fprintf(stderr, "the data of region %zu ended after %llu of %llu bytes%s%s\n", count - 1,
					r.length - left + (got > 0 ? (unsigned long long)got : 0), r.length,
					got < 0 ? ": " : "", got < 0 ? strerror(errno) : "");
				return EXIT_INPUT;
			}
			if (write_full(fd, buf, want) != 0) {
				fprintf(stderr, "write at byte %llu: %s\n", r.offset + (r.length - left), strerror(errno));
				return EXIT_WRITE;
			}
			left -= want;
		}
	}
	if (ioctl(fd, DKIOCSYNCHRONIZECACHE) != 0 && errno == EIO) {
		fprintf(stderr, "flushing the drive: %s\n", strerror(errno));
		return EXIT_WRITE;
	}
	fprintf(stderr, "written\n");

	for (i = 0; i < count; i++) {
		if (lseek(fd, (off_t)list[i].offset, SEEK_SET) != (off_t)list[i].offset) {
			fprintf(stderr, "seek to byte %llu: %s\n", list[i].offset, strerror(errno));
			return EXIT_READ;
		}
		for (left = list[i].length; left > 0;) {
			size_t want = left < CHUNK ? (size_t)left : CHUNK;
			ssize_t got = read_full(fd, buf, want);

			if (got < 0 || (size_t)got < want) {
				fprintf(stderr, "read at byte %llu: %s\n", list[i].offset + (list[i].length - left),
					got < 0 ? strerror(errno) : "the disk ended");
				return EXIT_READ;
			}
			if (write_full(STDOUT_FILENO, buf, want) != 0) {
				fprintf(stderr, "passing the read-back on: %s\n", strerror(errno));
				return EXIT_READ;
			}
			left -= want;
		}
	}
	free(list);
	return 0;
}

int main(int argc, char **argv)
{
	const char *device, *prompt;
	char *end;
	unsigned long long size, left, disk_size = 0;
	uint32_t block = 0;
	uint64_t blocks = 0;
	unsigned char *buf;
	void *mem = NULL;
	AuthorizationExternalForm ext;
	int fd, rc, regions;

	regions = argc > 1 && strcmp(argv[1], "--regions") == 0;
	if (argc - regions < 3 || argc - regions > 4) {
		fprintf(stderr, "usage: %s /dev/rdiskN SIZE [PROMPT]\n"
			"       %s --regions /dev/rdiskN END [PROMPT]\n", argv[0], argv[0]);
		return EXIT_ARGS;
	}
	argv += regions;
	argc -= regions;
	device = argv[1];
	prompt = argc > 3 ? argv[3] : NULL;
	errno = 0;
	size = strtoull(argv[2], &end, 10);
	if (!valid_device(device) || errno || *end || end == argv[2] || size == 0) {
		fprintf(stderr, "bad device or size\n");
		return EXIT_ARGS;
	}
	signal(SIGPIPE, SIG_IGN);

	rc = authorize(device, prompt, &ext);
	if (rc)
		return rc;
	fd = open_with_authopen(device, &ext);
	if (fd < 0)
		return EXIT_OPEN;

	if (ioctl(fd, DKIOCGETBLOCKSIZE, &block) != 0 || block == 0)
		block = 512;
	if (ioctl(fd, DKIOCGETBLOCKCOUNT, &blocks) == 0)
		disk_size = (unsigned long long)blocks * block;
	if (CHUNK % block != 0) {
		fprintf(stderr, "unsupported block size %u\n", (unsigned)block);
		return EXIT_OPEN;
	}
	if (disk_size && size > disk_size) {
		fprintf(stderr, "the disk holds %llu bytes, the image is %llu\n", disk_size, size);
		return EXIT_SMALL;
	}
	if (posix_memalign(&mem, 4096, CHUNK) != 0) {
		fprintf(stderr, "out of memory\n");
		return EXIT_OPEN;
	}
	buf = mem;
	fprintf(stderr, "opened %u %llu\n", (unsigned)block, disk_size);
	if (regions) {
		rc = write_regions(fd, block, size, buf);
		close(fd);
		return rc;
	}

	for (left = size; left > 0;) {
		size_t want = left < CHUNK ? (size_t)left : CHUNK;
		ssize_t got = read_full(STDIN_FILENO, buf, want);
		size_t padded;

		if (got < 0 || (size_t)got < want) {
			fprintf(stderr, "the image data ended after %llu of %llu bytes%s%s\n",
				size - left + (got > 0 ? (unsigned long long)got : 0), size,
				got < 0 ? ": " : "", got < 0 ? strerror(errno) : "");
			return EXIT_INPUT;
		}
		padded = (want + block - 1) / block * block;
		memset(buf + want, 0, padded - want);
		if (write_full(fd, buf, padded) != 0) {
			fprintf(stderr, "write at byte %llu: %s\n", size - left, strerror(errno));
			return EXIT_WRITE;
		}
		left -= want;
	}
	/* Ask the drive to finish; not every device knows the request. */
	if (ioctl(fd, DKIOCSYNCHRONIZECACHE) != 0 && errno == EIO) {
		fprintf(stderr, "flushing the drive: %s\n", strerror(errno));
		return EXIT_WRITE;
	}
	fprintf(stderr, "written\n");

	if (lseek(fd, 0, SEEK_SET) != 0) {
		fprintf(stderr, "seek to the start: %s\n", strerror(errno));
		return EXIT_READ;
	}
	for (left = size; left > 0;) {
		size_t want = left < CHUNK ? (size_t)left : CHUNK;
		size_t padded = (want + block - 1) / block * block;
		ssize_t got = read_full(fd, buf, padded);

		if (got < 0 || (size_t)got < want) {
			fprintf(stderr, "read at byte %llu: %s\n", size - left,
				got < 0 ? strerror(errno) : "the disk ended");
			return EXIT_READ;
		}
		if (write_full(STDOUT_FILENO, buf, want) != 0) {
			fprintf(stderr, "passing the read-back on: %s\n", strerror(errno));
			return EXIT_READ;
		}
		left -= want;
	}
	close(fd);
	return 0;
}
