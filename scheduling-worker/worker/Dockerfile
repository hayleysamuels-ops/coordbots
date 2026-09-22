# Separate Railway service; the dashboard keeps its existing build path.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY lib ./lib
COPY users.js ./users.js
COPY worker ./worker
ENV NODE_ENV=production
ENV HOME=/home/node
CMD ["node", "worker/bootstrap.js"]
