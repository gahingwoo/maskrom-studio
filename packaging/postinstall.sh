#!/bin/sh
# After installing the .deb or .rpm: Chromium's setuid sandbox helper must be
# owned by root and setuid on systems that do not allow unprivileged user
# namespaces; then apply the udev rule.
if [ -f /opt/woa-rk3576-imager/chrome-sandbox ]; then
    chown root:root /opt/woa-rk3576-imager/chrome-sandbox 2>/dev/null || true
    chmod 4755 /opt/woa-rk3576-imager/chrome-sandbox 2>/dev/null || true
fi
/bin/sh /usr/share/woa-rk3576-imager/udev-reload.sh
exit 0
