# Donyatt Flood Watch

A free community tool for drivers near Donyatt, Somerset. It combines Environment Agency river and rain data with road reports to give an **Open / Caution / Avoid** recommendation for the roads the River Isle floods. Never drive into floodwater.

Project brief and rules: [CLAUDE.md](CLAUDE.md).

## Status

- Stage 1 (collector): a Cloudflare Worker that stores the Donyatt river level, Chard Snowdon Hill rainfall and EA flood warnings every 15 minutes. `GET /health` shows the latest collected data.
