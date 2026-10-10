FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so the layer is cached across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY apps.json ./
COPY src src

# The database lives on a volume; on canclini-web-01 that is
# /srv/data/feedback mounted here.
ENV DATABASE_PATH=/data/feedback.db
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

# Late on purpose: an ARG busts every layer below it, so it sits after npm ci.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

CMD ["node", "src/main.ts"]
