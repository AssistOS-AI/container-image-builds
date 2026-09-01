FROM docker.io/assistos/ploinky-node:24-bookworm-tools@sha256:36d105c9a8a85c6acf895eccb0044bd7d1852fde9ae300d9f332ff314e250fca

USER root

ENV DEBIAN_FRONTEND=noninteractive

# The timestamped Debian archives and every direct package are immutable inputs.
# Transitive resolution is therefore fixed by the same reviewed repository state.
RUN set -eux; \
    rm -f /etc/apt/sources.list; \
    rm -f /etc/apt/sources.list.d/*; \
    printf '%s\n' \
        'deb https://snapshot.debian.org/archive/debian/20260831T000000Z/ bookworm main' \
        'deb https://snapshot.debian.org/archive/debian/20260831T000000Z/ bookworm-updates main' \
        'deb https://snapshot.debian.org/archive/debian-security/20260831T000000Z/ bookworm-security main' \
        > /etc/apt/sources.list; \
    printf '%s\n' \
        'Acquire::Check-Valid-Until "false";' \
        'Acquire::Retries "10";' \
        'Acquire::https::Timeout "60";' \
        'APT::Update::Error-Mode "any";' \
        > /etc/apt/apt.conf.d/99roboteam-snapshot; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        'ca-certificates=20250419~deb12u1' \
        'chromium=151.0.7922.173-1~deb12u1' \
        'dbus-x11=1.14.10-1~deb12u1' \
        'fonts-liberation=1:1.07.4-11' \
        'openbox=3.6.1-10' \
        'passwd=1:4.13+dfsg1-1+deb12u2' \
        'websockify=0.10.0+dfsg1-4+b1' \
        'x11vnc=0.9.16-9' \
        'xfonts-base=1:1.0.5+nmu1' \
        'xterm=379-1' \
        'xvfb=2:21.1.7-3+deb12u13'; \
    curl -fsSL \
        'https://snapshot.debian.org/archive/debian/20260831T000000Z/pool/main/n/novnc/novnc_1.3.0-1_all.deb' \
        -o /tmp/novnc.deb; \
    printf '%s  %s\n' \
        '5ff8b8c93c1c6cc911e01bfa77d12d4098e1904f738a996040c8095e02492ebb' \
        /tmp/novnc.deb \
        | sha256sum --check --strict -; \
    dpkg-deb --extract /tmp/novnc.deb /tmp/novnc-root; \
    cp -a /tmp/novnc-root/usr/share/novnc /usr/share/novnc; \
    install -d -o root -g root -m 0755 /usr/share/doc/novnc; \
    cp /tmp/novnc-root/usr/share/doc/novnc/copyright /usr/share/doc/novnc/copyright; \
    rm -rf /tmp/novnc.deb /tmp/novnc-root; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0444 sources.lock.json /usr/local/share/ploinky/roboteam-agent-sources.json

RUN set -eux; \
    for executable in \
        /bin/bash \
        /usr/bin/chromium \
        /usr/bin/dbus-launch \
        /usr/bin/getent \
        /usr/bin/openbox \
        /usr/bin/openbox-session \
        /usr/bin/passwd \
        /usr/bin/websockify \
        /usr/bin/x11vnc \
        /usr/bin/xterm \
        /usr/bin/Xvfb \
        /usr/sbin/useradd; do \
        test -x "$executable"; \
    done; \
    test -r /usr/share/novnc/core/rfb.js; \
    test "$(stat -c '%u:%g:%a' /usr/local/share/ploinky/roboteam-agent-sources.json)" = '0:0:444'; \
    node -e 'JSON.parse(require("node:fs").readFileSync("/usr/local/share/ploinky/roboteam-agent-sources.json", "utf8"))'; \
    test "$(dpkg-query -W -f='${Version}' ca-certificates)" = '20250419~deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' chromium)" = '151.0.7922.173-1~deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' dbus-x11)" = '1.14.10-1~deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' fonts-liberation)" = '1:1.07.4-11'; \
    test "$(dpkg-query -W -f='${Version}' openbox)" = '3.6.1-10'; \
    test "$(dpkg-query -W -f='${Version}' passwd)" = '1:4.13+dfsg1-1+deb12u2'; \
    test "$(dpkg-query -W -f='${Version}' websockify)" = '0.10.0+dfsg1-4+b1'; \
    test "$(dpkg-query -W -f='${Version}' x11vnc)" = '0.9.16-9'; \
    test "$(dpkg-query -W -f='${Version}' xfonts-base)" = '1:1.0.5+nmu1'; \
    test "$(dpkg-query -W -f='${Version}' xterm)" = '379-1'; \
    test "$(dpkg-query -W -f='${Version}' xvfb)" = '2:21.1.7-3+deb12u13'; \
    install -d -o root -g root -m 0755 /opt/roboteam-runtime; \
    printf 'roboteam-runtime-v1\n' > /opt/roboteam-runtime/contract-v1; \
    chown root:root /opt/roboteam-runtime/contract-v1; \
    chmod 0444 /opt/roboteam-runtime/contract-v1; \
    test "$(stat -c '%u:%g:%a' /opt/roboteam-runtime/contract-v1)" = '0:0:444'; \
    test "$(cat /opt/roboteam-runtime/contract-v1)" = 'roboteam-runtime-v1'; \
    test "$(wc -l < /opt/roboteam-runtime/contract-v1)" -eq 1

# The controller intentionally remains root. RoboTeam creates profile users,
# chowns their persistent directories, then starts desktop children as those UIDs.
USER root
WORKDIR /code
CMD ["bash"]
