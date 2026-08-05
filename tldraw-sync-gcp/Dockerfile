# --- Stage 1: Builder ---
FROM node:20-slim AS builder

# Enable corepack to use the correct yarn version
RUN corepack enable

WORKDIR /app

# Copy package config files first to leverage Docker caching
COPY package.json yarn.lock .yarnrc.yml ./

# Install ALL dependencies (including devDependencies like typescript)
# We need these to run the build script
RUN yarn install --immutable

# Copy the rest of the source code
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript code (outputs to /dist)
RUN yarn build

# --- Stage 2: Runner ---
FROM node:20-slim AS runner

# Enable corepack here too
RUN corepack enable

WORKDIR /app

# Copy package.json again (for the start script)
COPY package.json yarn.lock .yarnrc.yml ./

# Install ONLY production dependencies to keep image small
RUN yarn workspaces focus --production

# Copy the compiled code from the builder stage
COPY --from=builder /app/dist ./dist

# Set standard environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose the port the app runs on
EXPOSE 3001

# Start the application
CMD ["yarn", "start"]