FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app
COPY --chown=node:node package.json package-lock.json server.js ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/prepare-host.js ./scripts/prepare-host.js
COPY --chown=node:node scripts/prepare-snapshot.js ./scripts/prepare-snapshot.js
RUN mkdir -p /app/data /app/state && chown node:node /app/data /app/state
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s CMD node -e "fetch('http://127.0.0.1:3000/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
