FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit
COPY src ./src
COPY scripts/preflight.js ./scripts/preflight.js
COPY assets ./assets
ENV NODE_ENV=production BOT_MODE=recovery
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const req=require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)});req.setTimeout(4000,()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1))"
CMD ["npm", "start"]
