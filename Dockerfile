FROM node:20-bullseye-slim AS base
WORKDIR /usr/src/app
# THIS IS TO ENABLE PRISMA TO DETECT REQUIRED FILES
RUN apt-get update && apt-get install -y openssl libssl-dev

FROM base AS build
COPY ./package.json ./tsconfig.json ./
RUN yarn install --frozen-lockfile --network-timeout 100000
RUN npm install
COPY . .
RUN yarn prisma:generate && yarn build

FROM base AS production
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json
COPY --from=build /usr/src/app/prisma ./prisma
# COPY --from=build /usr/src/app/.env ./.env

CMD ["yarn", "start"]
