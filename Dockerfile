# Backey backend — long-running Node HTTP server with server-side Gemini proxy.
#
# The API key is NEVER baked into this image. It is injected at runtime as
# GEMINI_API_KEY (see DEPLOYMENT.md). With that variable set the server refuses
# POST/DELETE /api/key with 409 and performs no disk writes, so the container
# can run read-only.

FROM node:20-alpine

# Run as an unprivileged user; the app needs no elevated privileges.
RUN addgroup -S backey && adduser -S backey -G backey

WORKDIR /app

# Zero runtime dependencies, so there is no `npm install` step and no
# node_modules layer. package.json is copied for the `start` script and the
# engines constraint only.
COPY --chown=backey:backey package.json ./

# Only the files the server actually serves or executes.
COPY --chown=backey:backey server.mjs ./
COPY --chown=backey:backey index.html ./
COPY --chown=backey:backey lib/ ./lib/
# Included so `node scripts/check-gemini.mjs` can be run against the real API
# from inside the deployed environment.
COPY --chown=backey:backey scripts/ ./scripts/

USER backey

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# Container-level liveness probe against the app's own health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
