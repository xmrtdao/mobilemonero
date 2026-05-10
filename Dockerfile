# MobileMonero — Vite React on HuggingFace Spaces (Docker)
# Static build serving on port 7860

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV PORT=7860
ENV HOST=0.0.0.0
RUN npm install -g serve
COPY --from=builder /app/dist ./dist
EXPOSE 7860
CMD ["serve", "-s", "dist", "-l", "7860"]
