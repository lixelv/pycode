FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: the only ones are tree-sitter-c/-cpp's native Node
# bindings (node-gyp, needs Python), and we use just their .wasm.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Static files only: Python (Pyodide) and Ruff run in the browser.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
