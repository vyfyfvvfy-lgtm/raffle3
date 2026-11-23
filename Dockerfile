FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./

RUN npm ci

COPY . .

CMD ["npm", "start"]
