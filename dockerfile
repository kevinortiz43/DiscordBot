# Use official Node image as base
FROM node:18-slim

# Install Python (required by Playwright)
RUN apt-get update && \
    apt-get install -y python3 && \
    ln -s /usr/bin/python3 /usr/bin/python

# Set working directory
WORKDIR /app

# Install Playwright dependencies
RUN npx playwright install-deps

# Install Playwright browsers
RUN npx playwright install --force

# Install typescript and ts-node globally
RUN npm install -g typescript ts-node

# Copy package.json and install dependencies
COPY package.json ./
RUN npm ci

# Copy test files and HTML data
COPY . .

# Run tests when container starts
CMD ["npx", "playwright", "test"]