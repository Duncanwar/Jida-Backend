FROM node:20-bullseye-slim AS base

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y openssl

FROM base AS build

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN npx prisma generate
RUN yarn build

FROM base

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma
COPY --from=build /usr/src/app/package.json ./

CMD ["yarn", "start"]