// The same listing as check.py, compiled against EDK2's own headers
// (edk2-stable202602: MdePkg/Include, MdeModulePkg/Include), so the
// structure layouts, the bit fields of the FTW headers, the state values
// and HEADER_ALIGN are EDK2's, not a transcription. The walk is
// VariableParsing.c's (IsValidVariableHeader, GetNextVariablePtr,
// FindVariableEx); the FTW check is FtwMisc.c's FtwGetLastWriteHeader with
// UpdateWorkingBlock.c's InitializeLocalWorkSpaceHeader.
//
//   gcc -I edk2/MdePkg/Include -I edk2/MdePkg/Include/X64 -I edk2/MdeModulePkg/Include edk2-check.c
//   ./a.out AREA.bin          prints "name guid attributes data-hex" per live variable
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <Uefi.h>
#include <Pi/PiFirmwareVolume.h>
#include <Guid/VariableFormat.h>
#include <Guid/SystemNvDataGuid.h>

static EFI_GUID  mSystemNvData   = EFI_SYSTEM_NV_DATA_FV_GUID;
static EFI_GUID  mAuthStore      = EFI_AUTHENTICATED_VARIABLE_GUID;
static EFI_GUID  mPlainStore     = EFI_VARIABLE_GUID;
static EFI_GUID  mWorkingBlock   = EDKII_WORKING_BLOCK_SIGNATURE_GUID;

#define AREA_BYTES  0x30000
#define WORK_AT     0x10000
#define WORK_BYTES  0x10000

static void Fail (const char *m) { printf ("FAIL: %s\n", m); exit (1); }

static UINT32 Crc32 (const UINT8 *b, UINTN n)
{
  UINT32  c = 0xFFFFFFFF;
  for (UINTN i = 0; i < n; i++) {
    c ^= b[i];
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >> 1) : c >> 1;
  }
  return c ^ 0xFFFFFFFF;
}

static void PrintGuid (const EFI_GUID *g)
{
  printf ("%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x", g->Data1, g->Data2, g->Data3,
    g->Data4[0], g->Data4[1], g->Data4[2], g->Data4[3], g->Data4[4], g->Data4[5], g->Data4[6], g->Data4[7]);
}

static BOOLEAN  mAuth;
static UINTN HeaderSize (void) { return mAuth ? sizeof (AUTHENTICATED_VARIABLE_HEADER) : sizeof (VARIABLE_HEADER); }
static UINT32 NameSize (VARIABLE_HEADER *V) { return mAuth ? ((AUTHENTICATED_VARIABLE_HEADER *)V)->NameSize : V->NameSize; }
static UINT32 DataSize (VARIABLE_HEADER *V) { return mAuth ? ((AUTHENTICATED_VARIABLE_HEADER *)V)->DataSize : V->DataSize; }
static EFI_GUID *VendorGuid (VARIABLE_HEADER *V) { return mAuth ? &((AUTHENTICATED_VARIABLE_HEADER *)V)->VendorGuid : &V->VendorGuid; }
static UINT8 *NamePtr (VARIABLE_HEADER *V) { return (UINT8 *)V + HeaderSize (); }
static UINT8 *DataPtr (VARIABLE_HEADER *V) { return NamePtr (V) + NameSize (V) + GET_PAD_SIZE (NameSize (V)); }
static VARIABLE_HEADER *Next (VARIABLE_HEADER *V)
{
  UINTN  Value = (UINTN)DataPtr (V) + DataSize (V) + GET_PAD_SIZE (DataSize (V));
  return (VARIABLE_HEADER *)HEADER_ALIGN (Value);
}
static BOOLEAN IsValid (VARIABLE_HEADER *V, VARIABLE_HEADER *End)
{
  return V != NULL && V < End && V->StartId == VARIABLE_DATA;
}
static BOOLEAN IsLive (VARIABLE_HEADER *V)
{
  return V->State == VAR_ADDED || V->State == (VAR_IN_DELETED_TRANSITION & VAR_ADDED);
}
static BOOLEAN SameName (VARIABLE_HEADER *A, VARIABLE_HEADER *B)
{
  return memcmp (VendorGuid (A), VendorGuid (B), sizeof (EFI_GUID)) == 0 && NameSize (A) == NameSize (B) && memcmp (NamePtr (A), NamePtr (B), NameSize (A)) == 0;
}

int main (int argc, char **argv)
{
  static UINT8  Area[AREA_BYTES];
  FILE          *F;
  long          Len;
  UINTN         Base = 0;

  if (argc != 2) { fprintf (stderr, "usage: %s AREA.bin\n", argv[0]); return 2; }
  F = fopen (argv[1], "rb");
  if (!F) Fail ("cannot open");
  fseek (F, 0, SEEK_END);
  Len = ftell (F);
  if (Len == 16 * 1024 * 1024) Base = 0xFC0000;   // a whole ROCK 4D SPI NOR dump
  else if (Len != AREA_BYTES) Fail ("not 0x30000 bytes");
  fseek (F, (long)Base, SEEK_SET);
  if (fread (Area, 1, AREA_BYTES, F) != AREA_BYTES) Fail ("short read");
  fclose (F);

  EFI_FIRMWARE_VOLUME_HEADER  *Fv = (EFI_FIRMWARE_VOLUME_HEADER *)Area;
  if (Fv->Signature != EFI_FVH_SIGNATURE || Fv->Revision != EFI_FVH_REVISION || Fv->FvLength != AREA_BYTES) Fail ("FV header");
  if (memcmp (&Fv->FileSystemGuid, &mSystemNvData, sizeof (EFI_GUID)) != 0) Fail ("FV file system GUID");
  UINT16  Sum = 0;
  for (UINTN i = 0; i < Fv->HeaderLength / 2; i++) Sum += ((UINT16 *)Fv)[i];
  if (Sum != 0) Fail ("FV checksum");

  VARIABLE_STORE_HEADER  *Store = (VARIABLE_STORE_HEADER *)(Area + Fv->HeaderLength);
  if (memcmp (&Store->Signature, &mAuthStore, sizeof (EFI_GUID)) == 0) mAuth = TRUE;
  else if (memcmp (&Store->Signature, &mPlainStore, sizeof (EFI_GUID)) != 0) Fail ("store signature");
  if (Store->Format != VARIABLE_STORE_FORMATTED || Store->State != VARIABLE_STORE_HEALTHY) Fail ("store format or state");
  if (Store->Size != 0x10000 - Fv->HeaderLength) Fail ("store size");

  VARIABLE_HEADER  *Start = (VARIABLE_HEADER *)HEADER_ALIGN (Store + 1);                     // GetStartPointer
  VARIABLE_HEADER  *End   = (VARIABLE_HEADER *)HEADER_ALIGN ((UINTN)Store + Store->Size);    // GetEndPointer
  VARIABLE_HEADER  *V;
  UINTN            Records = 0, Live = 0;
  for (V = Start; IsValid (V, End); V = Next (V)) {
    if ((UINT8 *)DataPtr (V) + DataSize (V) > (UINT8 *)End) Fail ("variable past the store end");
    Records++;
  }
  for (UINT8 *P = (UINT8 *)V; P < (UINT8 *)Store + Store->Size; P++) if (*P != 0xFF) Fail ("free space not erased");

  // FindVariableEx for each live name: print the record it returns, in store order.
  for (V = Start; IsValid (V, End); V = Next (V)) {
    if (!IsLive (V)) continue;
    VARIABLE_HEADER  *Found = NULL, *InDeleted = NULL, *W;
    for (W = Start; IsValid (W, End); W = Next (W)) {
      if (!IsLive (W) || !SameName (V, W)) continue;
      if (W->State == (VAR_IN_DELETED_TRANSITION & VAR_ADDED)) InDeleted = W;
      else { Found = W; break; }
    }
    if (Found == NULL) Found = InDeleted;
    if (Found != V) continue;
    Live++;
    for (UINT32 i = 0; i + 2 < NameSize (V); i += 2) putchar (NamePtr (V)[i]);
    putchar (' ');
    PrintGuid (VendorGuid (V));
    printf (" 0x%x ", V->Attributes);
    for (UINT32 i = 0; i < DataSize (V); i++) printf ("%02x", DataPtr (V)[i]);
    putchar ('\n');
  }

  // FTW: the working block header must be the one InitializeLocalWorkSpaceHeader() makes.
  EFI_FAULT_TOLERANT_WORKING_BLOCK_HEADER  Want;
  memset (&Want, 0xFF, sizeof (Want));
  memcpy (&Want.Signature, &mWorkingBlock, sizeof (EFI_GUID));
  Want.WriteQueueSize = WORK_BYTES - sizeof (EFI_FAULT_TOLERANT_WORKING_BLOCK_HEADER);
  Want.Crc = Crc32 ((UINT8 *)&Want, sizeof (Want));
  Want.WorkingBlockValid   = FTW_VALID_STATE;
  Want.WorkingBlockInvalid = FTW_INVALID_STATE;
  if (memcmp (Area + WORK_AT, &Want, sizeof (Want)) != 0) Fail ("FTW working block header");
  // FtwGetLastWriteHeader, then: an allocated header that is not complete is a pending write.
  EFI_FAULT_TOLERANT_WRITE_HEADER  *H = (EFI_FAULT_TOLERANT_WRITE_HEADER *)(Area + WORK_AT + sizeof (Want));
  UINTN                            Offset = sizeof (Want);
  while (H->Complete == FTW_VALID_STATE) {
    Offset += FTW_WRITE_TOTAL_SIZE (H->NumberOfWrites, H->PrivateDataSize);
    if (Offset + sizeof (EFI_FAULT_TOLERANT_WRITE_HEADER) >= WORK_BYTES) Fail ("FTW work space full");
    H = (EFI_FAULT_TOLERANT_WRITE_HEADER *)(Area + WORK_AT + Offset);
  }
  if (H->HeaderAllocated == FTW_VALID_STATE) Fail ("FTW write pending");
  fprintf (stderr, "# %lu live of %lu records, %s store, FTW header at 0x%x, %lu-byte write header, %lu-byte record\n",
    (unsigned long)Live, (unsigned long)Records, mAuth ? "authenticated" : "plain", WORK_AT,
    (unsigned long)sizeof (EFI_FAULT_TOLERANT_WRITE_HEADER), (unsigned long)sizeof (EFI_FAULT_TOLERANT_WRITE_RECORD));
  return 0;
}
