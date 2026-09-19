FROM node:22.19.0-alpine3.22
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@10.17.1 --ignore-scripts && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY *.mjs ./
USER root
CMD ["node", "bridge.mjs"]
