# Cove VPS Listener Host

This directory documents the persistent browser host used by Cove Bridge.

Runtime stack:

- Xvfb virtual display on `:91`
- Openbox window manager
- Google Chrome with a persistent profile under `/opt/cove/listener/profile`
- x11vnc bound only to `127.0.0.1:5901`
- noVNC/websockify bound only to `127.0.0.1:6080`
- Chrome DevTools bound only to `127.0.0.1:9222`
- systemd restart policy via `cove-listener.service`

The browser profile contains the ChatGPT login/session state and must not be committed.

## One-time login

Create an SSH tunnel from the operator machine:

`ssh -L 6080:127.0.0.1:6080 <ssh-user>@<vps-host>`

Then open:

`http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale`

Log into ChatGPT, open the dedicated Listener conversation, mount Cove Bridge, and start listening.

Do not expose ports 5901, 6080, or 9222 publicly. They are intentionally loopback-only.
