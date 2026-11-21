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
//           Added: extra driver packages, the drivers' test certificates
//           (woa-certs.cmd, certs.ts), SetupComplete.cmd, the answer file
//           when setup is skipped, and OpenSSH (setup-files.ts).
//
// WinPE has find.exe but no findstr.exe, and set /a is 32-bit, as the
// comments in deploy-windows.cmd record; nothing here uses either for disk
// sizes or offsets: they are compared as strings.
//
// Written with \n here and given to the board with \r\n (cmd.exe needs CRLF
// for labels and goto to work reliably).

export const LAUNCHER = String.raw`@echo off
rem ---------------------------------------------------------------------------
rem WoA RK3576 Imager, staged install. This file replaces woa-debug\collect.cmd
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
  echo WoA RK3576 Imager: no volume has woa-stage.ini. Nothing to install.
  goto :eof
)
mkdir X:\woa-stage 2>nul
copy /y "%STAGE%\woa-stage.cmd" X:\woa-stage\woa-stage.cmd >nul || goto :nocopy
copy /y "%STAGE%\woa-stage.ini" X:\woa-stage\woa-stage.ini >nul || goto :nocopy
call X:\woa-stage\woa-stage.cmd %PE% %STAGE%
goto :eof
:nocopy
echo WoA RK3576 Imager: could not copy the install script from %STAGE% to X:.
`;

export const INSTALL = String.raw`@echo off
rem ---------------------------------------------------------------------------
rem woa-stage.cmd - install Windows onto the eMMC this WinPE was staged on.
rem Written by WoA RK3576 Imager; adapted from woa-rk3576's
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
echo WoA RK3576 Imager staged install, %DATE% %TIME% > "%LOG%"

for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%INI%") do set "W_%%a=%%b"
for %%k in (disk_guid disk_bytes fw_offset fw_size boot_offset data_offset windows_offset_kb image index build) do (
  if not defined W_%%k (
    echo woa-stage.ini has no %%k. Stopping.
    goto :fail
  )
)
set DRIVERS=%PE%\woa-drivers
set WIM=%STAGE%\%W_image%
echo.
echo ======================================================================
echo  WoA RK3576 Imager: installing %W_edition%
echo  ^(build %W_build%, index %W_index%^) onto this board's eMMC.
echo  The firmware partition is kept. Close this window or press Ctrl+C
echo  within 15 seconds to stop; nothing has been changed yet.
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
echo eMMC: disk %DISK%. Firmware partition found at sector 64; it is kept.

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
    echo The image on the eMMC does not have the SHA-256 the imager wrote:
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
  if not defined OFF set KEEP=1
  if not defined KEEP (
    >> X:\woa-stage\dp.txt echo select partition %%i
    >> X:\woa-stage\dp.txt echo delete partition override
    set /a NDEL+=1
  )
)
echo partitions left over from an earlier attempt: %NDEL% >> "%LOG%"
>> X:\woa-stage\dp.txt (
  echo create partition efi size=260 offset=%W_windows_offset_kb%
  echo format quick fs=fat32 label=System
  echo assign letter=S
  echo create partition msr size=16
  echo create partition primary
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

rem --- 4. apply, drivers, boot (deploy-windows.cmd) ----------------------------
echo.
echo Applying the image. This takes a while on eMMC ^(20 to 40 minutes^).
dism /English /Apply-Image /ImageFile:"%WIM%" /Index:%W_index% /ApplyDir:W:\ /Compact /Verify >> "%LOG%" 2>&1 || goto :faillog

echo Adding the RK3576 drivers.
dism /English /Image:W:\ /Add-Driver /Driver:"%DRIVERS%" /Recurse /ForceUnsigned >> "%LOG%" 2>&1 || goto :faillog
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

echo Making the eMMC's disk driver boot-start, and keeping sdbus off the eMMC.
reg load HKLM\WOASYS W:\Windows\System32\config\SYSTEM >> "%LOG%" 2>&1 || goto :faillog
set CS=1
for /f "tokens=3" %%v in ('reg query HKLM\WOASYS\Select /v Current ^| find "Current"') do set /a CS=%%v
reg add HKLM\WOASYS\ControlSet00!CS!\Services\sdstor /v Start /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Services\sdbus /v Start /t REG_DWORD /d 4 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Control\Power /v HibernateEnabled /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add HKLM\WOASYS\ControlSet00!CS!\Control\Power /v HibernateEnabledDefault /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add "HKLM\WOASYS\ControlSet00!CS!\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f >> "%LOG%" 2>&1
reg add "HKLM\WOASYS\ControlSet00!CS!\Control\Session Manager" /v PowerSimulateHiberBugcheck /t REG_DWORD /d 0x40 /f >> "%LOG%" 2>&1
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
if exist "%STAGE%\unattend.xml" (
  echo Setting up the account, so Windows skips its setup screens.
  mkdir W:\Windows\Panther 2>nul
  copy /y "%STAGE%\unattend.xml" W:\Windows\Panther\unattend.xml >nul || goto :faillog
  rem It holds the password (encoded): zero the staging copy.
  fsutil file setzerodata offset=0 length=1048576 "%STAGE%\unattend.xml" >nul 2>&1
  echo answer file in place, staging copy zeroed >> "%LOG%"
)
if exist "%STAGE%\openssh\sshd.exe" (
  echo Putting OpenSSH into Program Files.
  xcopy "%STAGE%\openssh" "W:\Program Files\OpenSSH\" /e /i /q /y >> "%LOG%" 2>&1 || goto :faillog
  if exist "%STAGE%\ssh-key\administrators_authorized_keys" copy /y "%STAGE%\ssh-key\administrators_authorized_keys" "W:\Program Files\OpenSSH\administrators_authorized_keys" >nul
)

rem --- 5. remove the staging partitions, give their space to Windows ---------
echo Removing the staging partitions and extending the Windows partition.
mkdir W:\Windows\Logs 2>nul
copy /y "%LOG%" W:\Windows\Logs\woa-stage.log >nul
set PEL=%PE:~0,1%
set STL=%STAGE:~0,1%
> X:\woa-stage\dp.txt (
  echo select volume %STL%
  echo delete volume override
  echo select volume %PEL%
  echo delete volume override
  echo select volume W
  echo extend
  echo list partition
)
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
ping -n 16 127.0.0.1 >nul
wpeutil reboot
goto :end

:checkfw
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
echo The staging partitions are still on the eMMC: restarting the board runs
echo this install again. To stop for good, write the firmware with "whole
echo image" from WoA RK3576 Imager or flash.gahingwoo.com.
:end
endlocal
`;

export const crlf = (s: string): Uint8Array => new TextEncoder().encode(s.replace(/\r?\n/g, '\r\n'));
