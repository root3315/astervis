# Smoke-test image: run the reconstructed backend bundle on the official Bun runtime.
FROM oven/bun:1
WORKDIR /app
COPY server.js /app/server.js
# The bundle reads PORT from env and calls .listen(); no package.json needed (single-file bundle).
CMD ["bun", "/app/server.js"]
