// The two scripts the staged WinPE runs on the board.
//
// launcher  replaces woa-debug\collect.cmd on the staged copy of the WinPE
//           volume only. woa-rk3576's startnet.cmd calls that file with the
//           volume's letter on every boot (tools/woa-debug/startnet.cmd
//           there), so a release WinPE runs this without being rebuilt.
// install   woa-stage.cmd on the staging exFAT volume. It is
//           woa-rk3576's tools/woa-deploy/deploy-windows.cmd, with what is
//           different when the image is on the same eMMC as the target:
//           the disk is found by the GUID the imager gave it, the
//           partitions go into the gap before the staging partitions, and
//           when Windows is in place the staging partitions are deleted and
//           the Windows partition is extended over them. The DISM, driver,
//           bcdboot and registry steps are deploy-windows.cmd's, unchanged.
//           Added: the board's drivers from the release's driver package
//           (driver-package.ts), extra driver packages, the drivers' test certificates
//           (woa-certs.cmd, certs.ts), SetupComplete.cmd, the answer file
//           when setup is skipped, and OpenSSH (setup-files.ts).
//
// WinPE has find.exe but no findstr.exe, and set /a is 32-bit, as the
// comments in deploy-windows.cmd record; nothing here uses either for disk
// sizes or offsets: they are compared as strings.
//
// Written with \n here and given to the board with \r\n (cmd.exe needs CRLF
// for labels and goto to work reliably).

import { notepadFixCmd } from './trim';

export const LAUNCHER = String.raw`@echo off
rem ---------------------------------------------------------------------------
rem Maskrom Studio, staged install. This file replaces woa-debug\collect.cmd
rem on the imager's staging copy of the woa-rk3576 WinPE volume, which
rem startnet.cmd calls with this volume's letter. It finds the staging volume
rem (the one with woa-stage.ini), copies the install script to the RAM disk
rem and runs it there, because the staging volumes are deleted at the end.
rem ---------------------------------------------------------------------------
setlocal
set PE=%~1
if "%PE%"=="" set PE=%~d0
set STAGE=
for %%d in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do if not defined STAGE if exist "%%d:\woa-stage.ini" set STAGE=%%d:
if not defined STAGE (
  echo Maskrom Studio: no volume has woa-stage.ini. Nothing to install.
  goto :eof
)
mkdir X:\woa-stage 2>nul
copy /y "%STAGE%\woa-stage.cmd" X:\woa-stage\woa-stage.cmd >nul || goto :nocopy
copy /y "%STAGE%\woa-stage.ini" X:\woa-stage\woa-stage.ini >nul || goto :nocopy
call X:\woa-stage\woa-stage.cmd %PE% %STAGE%
goto :eof
:nocopy
echo Maskrom Studio: could not copy the install script from %STAGE% to X:.
`;

/**
 * Everything done to the applied Windows, the same on the board (INSTALL)
 * and on a Windows PC (HOST_BUILD): deploy-windows.cmd's steps and the
 * first-start files. Needs W: (Windows) and S: (ESP), %WIM%, %DRIVERS%, %AUDIO%,
 * %STAGE% (the folder with the generated files), %LOG%, %APPLY_OPTS% and the
 * W_ settings; jumps to :faillog on an error.
 */
export const CONFIGURE = String.raw`rem --- 4. apply, drivers, boot (deploy-windows.cmd) ----------------------------
echo.
rem Only the eMMC install on the board has been timed (20 to 40 minutes).
if /i "%W_target%"=="emmc" if /i not "%W_mode%"=="vhd" echo Applying the image. This takes a while ^(20 to 40 minutes on eMMC^).
if /i "%W_target%"=="emmc" if /i "%W_mode%"=="vhd" echo Applying the image. This takes a while.
if /i "%W_target%"=="sd" echo Applying the image. This takes a while; SD cards are slow to write.
if /i "%W_target%"=="nvme" echo Applying the image. This takes a while.
dism /English /Apply-Image /ImageFile:"%WIM%" /Index:%W_index% /ApplyDir:W:\ %APPLY_OPTS% >> "%LOG%" 2>&1 || goto :faillog

rem The board's drivers from the release's RK3576 driver package (driver-package.ts),
rem or, from a release without one, the drivers the WinPE image carries.
if exist "%STAGE%\rk3576-drivers\dwcsdhc" (
  echo Adding the RK3576 driver package for this board.
  dism /English /Image:W:\ /Add-Driver /Driver:"%STAGE%\rk3576-drivers" /Recurse /ForceUnsigned >> "%LOG%" 2>&1 || goto :faillog
) else (
  echo Adding the RK3576 drivers of the WinPE image.
  dism /English /Image:W:\ /Add-Driver /Driver:"%DRIVERS%" /Recurse /ForceUnsigned >> "%LOG%" 2>&1 || goto :faillog
  if exist "%AUDIO%" dism /English /Image:W:\ /Add-Driver /Driver:"%AUDIO%" /Recurse /ForceUnsigned >> "%LOG%" 2>&1 || goto :faillog
)
if exist "%STAGE%\extra-drivers" (
  echo Adding the extra drivers.
  dism /English /Image:W:\ /Add-Driver /Driver:"%STAGE%\extra-drivers" /Recurse /ForceUnsigned >> "%LOG%" 2>&1 || goto :faillog
)

echo Writing the boot files.
bcdboot W:\Windows /s S: /f UEFI >> "%LOG%" 2>&1 || goto :faillog
bcdedit /store S:\EFI\Microsoft\Boot\BCD /set {default} testsigning on >> "%LOG%" 2>&1 || goto :faillog
if not exist S:\EFI\Boot\bootaa64.efi (
  mkdir S:\EFI\Boot 2>nul
  copy /y S:\EFI\Microsoft\Boot\bootmgfw.efi S:\EFI\Boot\bootaa64.efi >> "%LOG%" 2>&1
)

rem The same settings for every target; only what is said differs.
if /i "%W_target%"=="emmc" echo Making the eMMC's disk driver boot-start, and keeping sdbus off the eMMC.
if /i "%W_target%"=="sd" echo Making the SD card's disk drivers boot-start, and keeping sdbus off the card.
if /i "%W_target%"=="nvme" echo Keeping sdbus off the SD slot, and turning hibernation and Fast Startup off.
reg load HKLM\WOASYS W:\Windows\System32\config\SYSTEM >> "%LOG%" 2>&1 || goto :faillog
set CS=1
for /f "tokens=3" %%v in ('reg query HKLM\WOASYS\Select /v Current ^| find "Current"') do set /a CS=%%v
reg add HKLM\WOASYS\ControlSet00!CS!\Services\sdstor /v Start /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
rem Windows on the SD card: the SD slot's controller driver must start at boot too.
if /i "%W_target%"=="sd" reg add HKLM\WOASYS\ControlSet00!CS!\Services\dwcmshc /v Start /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Services\sdbus /v Start /t REG_DWORD /d 4 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Control\Power /v HibernateEnabled /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Control\Power /v HibernateEnabledDefault /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add "HKLM\WOASYS\ControlSet00!CS!\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add "HKLM\WOASYS\ControlSet00!CS!\Control\Session Manager" /v PowerSimulateHiberBugcheck /t REG_DWORD /d 0x40 /f >> "%LOG%" 2>&1
rem The boards' RTC keeps UTC (and on the TaishanPi 3M holds no valid time at
rem all): read it as UTC, and let the Windows Time service start on its own.
reg add "HKLM\WOASYS\ControlSet00!CS!\Control\TimeZoneInformation" /v RealTimeIsUniversal /t REG_DWORD /d 1 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Services\W32Time /v Start /t REG_DWORD /d 2 /f >> "%LOG%" 2>&1
reg unload HKLM\WOASYS >> "%LOG%" 2>&1

echo Letting OOBE finish without a network.
reg load HKLM\WOAOFF W:\Windows\System32\config\SOFTWARE >> "%LOG%" 2>&1 || goto :faillog
reg add HKLM\WOAOFF\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f >> "%LOG%" 2>&1
rem The drivers' test certificates in Root and TrustedPublisher, so Plug and
rem Play installs them without asking (woa-rk3576 docs/INSTALL.md).
if exist "%STAGE%\woa-certs.cmd" (
  echo Trusting the drivers' test certificates.
  call "%STAGE%\woa-certs.cmd" >> "%LOG%" 2>&1
)
reg unload HKLM\WOAOFF >> "%LOG%" 2>&1

rem --- 4b. first start: SetupComplete.cmd, the answer file, OpenSSH -----------
mkdir W:\Windows\Setup\Scripts 2>nul
copy /y "%STAGE%\SetupComplete.cmd" W:\Windows\Setup\Scripts\SetupComplete.cmd >nul || goto :faillog
if exist "%STAGE%\woa-selftest.ps1" copy /y "%STAGE%\woa-selftest.ps1" W:\Windows\Setup\Scripts\woa-selftest.ps1 >nul
if exist "%STAGE%\rk3576-browser-gpu.ps1" copy /y "%STAGE%\rk3576-browser-gpu.ps1" W:\Windows\Setup\Scripts\rk3576-browser-gpu.ps1 >nul
rem The desktop folder's scripts (desktop-tools.ts): they stay here, the folder holds shortcuts.
for %%f in (woa-desktop-tools.ps1 woa-diag.ps1 woa-ssh-fix.ps1 woa-browser-gpu-switch.ps1) do if exist "%STAGE%\%%f" copy /y "%STAGE%\%%f" W:\Windows\Setup\Scripts\%%f >nul
if exist "%STAGE%\unattend.xml" (
  echo Setting up the account, so Windows skips its setup screens.
  mkdir W:\Windows\Panther 2>nul
  copy /y "%STAGE%\unattend.xml" W:\Windows\Panther\unattend.xml >nul || goto :faillog
  rem It holds the password (encoded): zero the staging copy.
  fsutil file setzerodata offset=0 length=1048576 "%STAGE%\unattend.xml" >nul 2>&1
  echo answer file in place, staging copy zeroed >> "%LOG%"
)
if exist "%STAGE%\woa-autologon.ps1" (
  rem Automatic sign-in on every start, see setup-files.ts. It holds the password too.
  copy /y "%STAGE%\woa-autologon.ps1" W:\Windows\Setup\Scripts\woa-autologon.ps1 >nul || goto :faillog
  fsutil file setzerodata offset=0 length=1048576 "%STAGE%\woa-autologon.ps1" >nul 2>&1
  echo automatic sign-in script in place, staging copy zeroed >> "%LOG%"
)
if exist "%STAGE%\openssh\sshd.exe" (
  echo Putting OpenSSH into Program Files.
  xcopy "%STAGE%\openssh" "W:\Program Files\OpenSSH\" /e /i /q /y >> "%LOG%" 2>&1 || goto :faillog
  if exist "%STAGE%\ssh-key\administrators_authorized_keys" copy /y "%STAGE%\ssh-key\administrators_authorized_keys" "W:\Program Files\OpenSSH\administrators_authorized_keys" >nul
)

rem --- 4c. Notepad: only on images whose Notepad app cannot start (trim.ts, notepadFixCmd)
${notepadFixCmd()}
rem --- 4d. trimming and the RK3576 tools (each optional; neither stops the install)
if exist "%STAGE%\woa-trim.cmd" (
  echo Trimming Windows: apps and background services, as chosen.
  call "%STAGE%\woa-trim.cmd"
)
if exist "%STAGE%\rk3576-tools\offline-install.cmd" (
  echo Installing the RK3576 tools.
  rem Its own cmd: the bundle's script keeps its variables to itself. No /hook:
  rem SetupComplete.cmd above already calls its first-boot step.
  cmd /c ""%STAGE%\rk3576-tools\offline-install.cmd" W:\" >> "%LOG%" 2>&1 || echo The RK3576 tools could not be installed ^(exit !errorlevel!^); Windows goes on without them. >> "%LOG%"
)

`;

export const INSTALL = String.raw`@echo off
rem ---------------------------------------------------------------------------
rem woa-stage.cmd - install Windows onto the disk this WinPE was staged on
rem (the board's eMMC, an SD card or an NVMe drive: W_target).
rem Written by Maskrom Studio; adapted from woa-rk3576's
rem tools/woa-deploy/deploy-windows.cmd (see the comments there for why each
rem step is needed). Run from X:\woa-stage\ by the launcher, with
rem   %1  the staged WinPE volume (drivers in woa-drivers\)
rem   %2  the staging data volume (the Windows image, woa-stage.ini)
rem
rem It is safe to run again after a power cut: partitions other than the
rem firmware and the two staging ones are deleted first.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set PE=%~1
set STAGE=%~2
set LOG=X:\woa-stage\woa-stage.log
set INI=X:\woa-stage\woa-stage.ini
echo Maskrom Studio staged install, %DATE% %TIME% > "%LOG%"

for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%INI%") do set "W_%%a=%%b"
rem What the target is called on the screen.
set "TGT=this board's eMMC"
if /i "%W_target%"=="sd" set "TGT=the SD card"
if /i "%W_target%"=="nvme" set "TGT=the NVMe drive"
for %%k in (target disk_guid disk_bytes fw_offset fw_size boot_offset data_offset windows_offset_kb image index build) do (
  if not defined W_%%k (
    echo woa-stage.ini has no %%k. Stopping.
    goto :fail
  )
)
set DRIVERS=%PE%\woa-drivers
set AUDIO=%PE%\woa-audio
set WIM=%STAGE%\%W_image%
echo.
echo ======================================================================
echo  Maskrom Studio: installing %W_edition%
echo  ^(build %W_build%, index %W_index%^) onto %TGT%.
if not "%W_fw_offset%"=="none" echo  The firmware partition is kept.
echo  Close this window or press Ctrl+C within 15 seconds to stop;
echo  nothing has been changed yet.
echo ======================================================================
ping -n 16 127.0.0.1 >nul
type "%INI%" >> "%LOG%"

for %%L in (S W) do (
  if exist %%L:\ (
    echo Drive letter %%L: is already in use. Stopping before changing anything.
    goto :fail
  )
)
if not exist "%DRIVERS%\dwcsdhc\dwcsdhc.inf" (
  echo No driver packages at %DRIVERS%. Stopping.
  goto :fail
)
if not exist "%WIM%" (
  echo %WIM% is missing. Stopping.
  goto :fail
)

rem --- 1. the disk the imager staged: its GPT disk GUID ---------------------
set DISK=
set NDISK=0
for /f "tokens=2 delims==" %%a in ('wmic diskdrive get Index /value ^| find "="') do (
  for %%b in (%%a) do (
    > X:\woa-stage\dp.txt echo select disk %%b
    >> X:\woa-stage\dp.txt echo uniqueid disk
    diskpart /s X:\woa-stage\dp.txt > X:\woa-stage\dpout.txt 2>&1
    find /i "%W_disk_guid%" X:\woa-stage\dpout.txt >nul && (
      set DISK=%%b
      set /a NDISK+=1
    )
  )
)
if not "%NDISK%"=="1" (
  echo Expected one disk with GUID %W_disk_guid%, found %NDISK%. Stopping.
  goto :fail
)
set SIZE=
for /f "tokens=2 delims==" %%a in ('wmic diskdrive where "Index=%DISK%" get Size /value ^| find "="') do for %%b in (%%a) do set SIZE=%%b
echo disk=%DISK% size=%SIZE% >> "%LOG%"
rem wmic reports the size in whole tracks, a little under the real size; the
rem GUID is what identifies the disk, the size only has to agree in its
rem number of digits and its leading two (whole GB), as in deploy-windows.cmd.
set SZA=!SIZE!x
set SZB=!W_disk_bytes!x
if not "!SIZE:~0,2!!SZA:~11,1!"=="!W_disk_bytes:~0,2!!SZB:~11,1!" (
  echo Disk %DISK% is %SIZE% bytes, the staged disk was %W_disk_bytes%. Stopping.
  goto :fail
)

call :checkfw || goto :fail
echo.
if "%W_fw_offset%"=="none" (
  echo Target: disk %DISK% ^(%W_target%^), the staged disk.
) else (
  echo eMMC: disk %DISK%. Firmware partition found at sector 64; it is kept.
)

rem --- 2. the image ---------------------------------------------------------
dism /English /Get-ImageInfo /ImageFile:"%WIM%" /Index:%W_index% > X:\woa-stage\img.txt 2>&1 || (
  echo DISM cannot read index %W_index% of %WIM%. What it said:
  type X:\woa-stage\img.txt
  goto :faillog
)
type X:\woa-stage\img.txt >> "%LOG%"
set ARCH=
for /f "tokens=2 delims=:" %%a in ('type X:\woa-stage\img.txt ^| find /i "Architecture"') do for %%b in (%%a) do set ARCH=%%b
if /i not "%ARCH%"=="arm64" (
  echo The image reports architecture "%ARCH%", not arm64. Stopping.
  goto :faillog
)
set BUILD=
for /f "tokens=5 delims=. " %%v in ('type X:\woa-stage\img.txt ^| find /i "Version :"') do if not defined BUILD set BUILD=%%v
set /a BNUM=%BUILD% 2>nul
if %BNUM% GTR 25999 (
  echo This image is build %BNUM%. Windows 11 24H2 and later cannot run on RK3576.
  goto :faillog
)
if %BNUM% LSS 10000 (
  echo Could not read the image's build number ^(got "%BUILD%"^).
  goto :faillog
)
if exist X:\Windows\System32\certutil.exe if defined W_image_sha256 (
  echo Checking the image's SHA-256. This reads the whole image once.
  certutil -hashfile "%WIM%" SHA256 > X:\woa-stage\hash.txt 2>&1
  find /i "%W_image_sha256%" X:\woa-stage\hash.txt >nul || (
    echo The image on %TGT% does not have the SHA-256 the imager wrote:
    type X:\woa-stage\hash.txt
    goto :faillog
  )
  echo image sha256 matches >> "%LOG%"
) else (
  echo no certutil in this WinPE: the image is checked by DISM /Verify while it is applied >> "%LOG%"
)

rem --- 3. partitions: clear the gap, then ESP + MSR + Windows in it ----------
call :listparts || goto :faillog
> X:\woa-stage\dp.txt echo select disk %DISK%
set NDEL=0
for /l %%i in (%NPART%,-1,1) do (
  > X:\woa-stage\dq.txt echo select disk %DISK%
  >> X:\woa-stage\dq.txt echo select partition %%i
  >> X:\woa-stage\dq.txt echo detail partition
  diskpart /s X:\woa-stage\dq.txt > X:\woa-stage\dqout.txt 2>&1
  set OFF=
  for /f "tokens=2 delims=:" %%o in ('type X:\woa-stage\dqout.txt ^| find /i "Offset in Bytes"') do for %%p in (%%o) do set OFF=%%p
  set KEEP=
  if "!OFF!"=="%W_fw_offset%" set KEEP=1
  if "!OFF!"=="%W_boot_offset%" set KEEP=1
  if "!OFF!"=="%W_data_offset%" set KEEP=1
  if "!OFF!"=="%W_linux_offset%" set KEEP=1
  if not defined OFF set KEEP=1
  if not defined KEEP (
    >> X:\woa-stage\dp.txt echo select partition %%i
    >> X:\woa-stage\dp.txt echo delete partition override
    set /a NDEL+=1
  )
)
echo partitions left over from an earlier attempt: %NDEL% >> "%LOG%"
rem The Windows partition: the whole gap, or the size chosen in the imager
rem (windows_create_mb; 0 is the whole gap).
if not defined W_windows_create_mb set W_windows_create_mb=0
set WSIZE=
if not "%W_windows_create_mb%"=="0" set WSIZE= size=%W_windows_create_mb%
>> X:\woa-stage\dp.txt (
  echo create partition efi size=260 offset=%W_windows_offset_kb%
  echo format quick fs=fat32 label=System
  echo assign letter=S
  echo create partition msr size=16
  echo create partition primary!WSIZE!
  echo format quick fs=ntfs label=Windows
  echo assign letter=W
  echo list partition
)
type X:\woa-stage\dp.txt >> "%LOG%"
echo Creating the Windows partitions.
diskpart /s X:\woa-stage\dp.txt >> "%LOG%" 2>&1 || goto :faillog
if not exist S:\ goto :faillog
if not exist W:\ goto :faillog
call :checkfw || goto :faillog

set APPLY_OPTS=/Compact /Verify
${CONFIGURE}rem --- 5. remove the staging partitions, give their space to Windows ---------
echo Removing the staging partitions and giving their space to Windows (and the data partition).
mkdir W:\Windows\Logs 2>nul
copy /y "%LOG%" W:\Windows\Logs\woa-stage.log >nul
set PEL=%PE:~0,1%
set STL=%STAGE:~0,1%
rem How far Windows grows over the freed space (windows_extend_mb: all, none
rem or a number of MiB), then the data partition if one was chosen; what
rem is left stays unallocated (for Linux later, or nothing).
if not defined W_windows_extend_mb set W_windows_extend_mb=all
if not defined W_data_fs set W_data_fs=none
> X:\woa-stage\dp.txt (
  echo select volume %STL%
  echo delete volume override
  echo select volume %PEL%
  echo delete volume override
  echo select volume W
)
if /i "%W_windows_extend_mb%"=="all" (
  >> X:\woa-stage\dp.txt echo extend
) else if /i not "%W_windows_extend_mb%"=="none" (
  >> X:\woa-stage\dp.txt echo extend size=%W_windows_extend_mb%
)
if /i not "%W_data_fs%"=="none" (
  >> X:\woa-stage\dp.txt echo select disk %DISK%
  >> X:\woa-stage\dp.txt echo create partition primary size=%W_data_mb%
  >> X:\woa-stage\dp.txt echo format quick fs=%W_data_fs% label=%W_data_label%
)
>> X:\woa-stage\dp.txt echo list partition
diskpart /s X:\woa-stage\dp.txt >> "%LOG%" 2>&1 || (
  echo Removing the staging partitions failed. Windows is installed; the
  echo staging partitions may still be there. Delete them from Disk Management.
  copy /y "%LOG%" W:\Windows\Logs\woa-stage.log >nul
  goto :faillog
)
call :checkfw || goto :faillog
copy /y "%LOG%" W:\Windows\Logs\woa-stage.log >nul

echo.
echo Done. The board restarts into Windows in 15 seconds. The first start
echo takes a few minutes and restarts once. The log is in
echo C:\Windows\Logs\woa-stage.log.
if defined W_linux_offset if not "%W_linux_offset%"=="none" (
  echo.
  echo Armbian is on the eMMC too. To start it, choose "Armbian (U-Boot^)" in
  echo the firmware's boot manager; the boot after that is Windows again.
)
if "%W_armbian_sd%"=="1" (
  echo.
  echo Armbian is on the SD card Maskrom Studio wrote. Once Windows has
  echo started, put the card in the SD slot and leave it there. To start
  echo Armbian, choose "Armbian (U-Boot^)" in the firmware's boot manager;
  echo the boot after that is Windows again. If Windows offers to format the
  echo card, say no: Windows cannot read Armbian's file system.
)
ping -n 16 127.0.0.1 >nul
wpeutil reboot
goto :end

:checkfw
rem An SD card or NVMe drive has no firmware partition to keep.
if "%W_fw_offset%"=="none" exit /b 0
set P0OFF=
set P0SIZE=
for /f "tokens=1,2 delims==" %%a in ('wmic partition where "DiskIndex=%DISK% and Index=0" get StartingOffset^,Size /value ^| find "="') do (
  for %%c in (%%b) do (
    if /i "%%a"=="StartingOffset" set P0OFF=%%c
    if /i "%%a"=="Size" set P0SIZE=%%c
  )
)
if not "%P0OFF%"=="%W_fw_offset%" goto :badfw
if not "%P0SIZE%"=="%W_fw_size%" goto :badfw
exit /b 0
:badfw
echo Disk %DISK% partition 1 starts at %P0OFF% and is %P0SIZE% bytes long, not
echo the firmware partition ^(%W_fw_offset%, %W_fw_size%^). Stopping.
exit /b 1

:listparts
> X:\woa-stage\dq.txt echo select disk %DISK%
>> X:\woa-stage\dq.txt echo list partition
diskpart /s X:\woa-stage\dq.txt > X:\woa-stage\parts.txt 2>&1 || exit /b 1
type X:\woa-stage\parts.txt >> "%LOG%"
set NPART=0
for /f "tokens=2" %%p in ('type X:\woa-stage\parts.txt ^| find "Partition "') do if not "%%p"=="###" set /a NPART+=1
exit /b 0

:faillog
echo Something failed. The log follows; it is also in %LOG% and, once the
echo Windows partition exists, in W:\Windows\Logs\woa-stage.log.
type "%LOG%"
if exist W:\Windows copy /y "%LOG%" W:\Windows\Logs\woa-stage.log >nul 2>&1
:fail
echo.
echo The staging partitions are still on %TGT%: restarting the board runs
echo this install again.
if "%W_fw_offset%"=="none" (
  echo To stop for good, take the drive out or write it again from Maskrom Studio.
) else (
  echo To stop for good, write the firmware with "whole image" from Maskrom
  echo Studio or flash.gahingwoo.com.
)
:end
endlocal
`;

/**
 * host-build.cmd: a finished Windows built on a Windows PC with its own DISM,
 * as Windows on Raspberry's tools do it (the PC may be x64; DISM applies and
 * services an ARM64 image). Run elevated by the app from a folder holding
 * host-build.ini, woa-drivers\ (from the WinPE release), and the generated
 * files of the staged install. Two modes:
 *   disk  an SD card or NVMe drive attached to this PC: cleaned, fresh GPT.
 *   vhd   an expandable VHD the size of the board's eMMC, with the first
 *         64 MiB left free for the firmware partition; the app then writes
 *         its partitions to the eMMC over Maskrom (src/woa/host-image.ts).
 */
export const HOST_BUILD = String.raw`@echo off
setlocal enabledelayedexpansion
set HERE=%~dp0
set HERE=%HERE:~0,-1%
set STAGE=%HERE%
set DRIVERS=%HERE%\woa-drivers
set AUDIO=%HERE%\woa-audio
set LOG=%HERE%\host-build.log
set INI=%HERE%\host-build.ini
echo Maskrom Studio host build, %DATE% %TIME% > "%LOG%"
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%INI%") do set "W_%%a=%%b"
for %%k in (mode target source source_kind index build) do (
  if not defined W_%%k (
    echo host-build.ini has no %%k.
    goto :faillog
  )
)
for %%L in (S W) do (
  if exist %%L:\ (
    echo Drive letter %%L: is in use on this PC. Free it and try again.
    goto :faillog
  )
)

rem --- the image: install.wim inside the ISO, mounted read-only ----------------
set ISOL=
if /i "%W_source_kind%"=="iso" (
  echo Mounting the ISO.
  for /f %%d in ('powershell -NoProfile -Command "(Mount-DiskImage -ImagePath '%W_source%' -PassThru | Get-Volume).DriveLetter"') do set ISOL=%%d
  if not defined ISOL (
    echo The ISO could not be mounted.
    goto :faillog
  )
  set WIM=!ISOL!:\%W_inner%
) else (
  set WIM=%W_source%
)
dism /English /Get-ImageInfo /ImageFile:"%WIM%" /Index:%W_index% > "%HERE%\img.txt" 2>&1 || goto :faillog
type "%HERE%\img.txt" >> "%LOG%"
set BUILD=
for /f "tokens=5 delims=. " %%v in ('type "%HERE%\img.txt" ^| find /i "Version :"') do if not defined BUILD set BUILD=%%v
set /a BNUM=%BUILD% 2>nul
if %BNUM% GTR 25999 (
  echo This image is build %BNUM%. Windows 11 24H2 and later cannot run on RK3576.
  goto :faillog
)

rem --- the target ---------------------------------------------------------------
if /i "%W_mode%"=="vhd" (
  echo Making a virtual disk the size of the eMMC.
  if exist "%W_vhd_path%" del /f /q "%W_vhd_path%"
  > "%HERE%\dp.txt" (
    echo create vdisk file="%W_vhd_path%" maximum=%W_vhd_mb% type=expandable
    echo select vdisk file="%W_vhd_path%"
    echo attach vdisk
    echo convert gpt
    echo create partition efi size=260 offset=65536
    echo format quick fs=fat32 label=System
    echo assign letter=S
    echo create partition msr size=16
    echo create partition primary
    echo format quick fs=ntfs label=Windows
    echo assign letter=W
  )
) else (
  set SIZE=
  for /f "tokens=2 delims==" %%a in ('wmic diskdrive where "Index=%W_disk_number%" get Size /value ^| find "="') do for %%b in (%%a) do set SIZE=%%b
  set SZA=!SIZE!x
  set SZB=%W_disk_bytes%x
  if not "!SIZE:~0,2!!SZA:~11,1!!SZA:~12,1!"=="%W_disk_bytes:~0,2%!SZB:~11,1!!SZB:~12,1!" (
    echo Disk %W_disk_number% is !SIZE! bytes, not the %W_disk_bytes% bytes chosen. Stopping.
    goto :faillog
  )
  echo Partitioning disk %W_disk_number%.
  > "%HERE%\dp.txt" (
    echo select disk %W_disk_number%
    echo clean
    echo convert gpt
    echo create partition efi size=260
    echo format quick fs=fat32 label=System
    echo assign letter=S
    echo create partition msr size=16
    echo create partition primary
    echo format quick fs=ntfs label=Windows
    echo assign letter=W
  )
)
type "%HERE%\dp.txt" >> "%LOG%"
diskpart /s "%HERE%\dp.txt" >> "%LOG%" 2>&1 || goto :faillog
if not exist S:\ goto :faillog
if not exist W:\ goto :faillog

if /i "%W_target%"=="nvme" (set APPLY_OPTS=/Verify) else (set APPLY_OPTS=/Compact /Verify)
${CONFIGURE}
mkdir W:\Windows\Logs 2>nul
copy /y "%LOG%" W:\Windows\Logs\woa-host-build.log >nul
call :release
echo WOA-HOST-BUILD-OK
echo WOA-HOST-BUILD-OK >> "%LOG%"
exit /b 0

:release
if /i "%W_mode%"=="vhd" (
  > "%HERE%\dq.txt" (
    echo select vdisk file="%W_vhd_path%"
    echo detach vdisk
  )
) else (
  > "%HERE%\dq.txt" (
    echo select volume S
    echo remove letter=S
    echo select volume W
    echo remove letter=W
  )
)
diskpart /s "%HERE%\dq.txt" >> "%LOG%" 2>&1
if defined ISOL powershell -NoProfile -Command "Dismount-DiskImage -ImagePath '%W_source%'" >> "%LOG%" 2>&1
exit /b 0

:faillog
call :release
echo WOA-HOST-BUILD-FAILED
echo WOA-HOST-BUILD-FAILED >> "%LOG%"
exit /b 1
`;

export const crlf = (s: string): Uint8Array => new TextEncoder().encode(s.replace(/\r?\n/g, '\r\n'));
