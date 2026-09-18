FROM node:22-bookworm-slim
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY worker ./worker
COPY src/scheduling/worker-auth.js ./src/scheduling/worker-auth.js
ENV NODE_ENV=production HOME=/home/node
CMD ["node", "worker/bootstrap.js"]
