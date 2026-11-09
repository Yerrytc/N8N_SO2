FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
USER 1000:1000
EXPOSE 3000
CMD ["node", "src/index.js"]
