FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 143 993 110 995 587 465
USER node
CMD ["node", "dist/index.js"]
