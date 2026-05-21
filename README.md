# Darveys Wishlist App

Shopify Wishlist app for Darveys. The app is currently configured as a Shopify React Router app and is deployed on Render. This document explains the current architecture and the required steps to migrate the app from Render to AWS.

## Current Hosting

- Current platform: Render
- Current app URL: `https://darveys-wishlist.onrender.com/`
- Target platform: AWS
- Runtime: Node.js 20
- App port: `3000`
- Deployment mode: Docker

## Application Overview

This app provides wishlist functionality through Shopify app proxy routes. Wishlist data is not stored in the application database. Instead, wishlist data is stored directly on the Shopify customer using customer metafields.

Wishlist metafield configuration:

```ts
const WISHLIST_NAMESPACE = "custom";
const WISHLIST_KEY = "wishlist";
const WISHLIST_TYPE = "json";
```

The app reads and writes wishlist data through Shopify Admin GraphQL APIs. The app database is used only for Shopify app session storage.

## Tech Stack

- Shopify React Router app
- React 18
- React Router 7
- Shopify App Bridge
- Shopify app session storage with Prisma
- Prisma ORM
- Docker

## Important Data Note

Wishlist data is stored in Shopify customer metafields, not in the app database.

During hosting migration:

- No wishlist data export is required.
- No wishlist data import is required.
- Existing customer wishlist data remains available in Shopify.
- Only app hosting, Shopify configuration, secrets, and session storage need to be migrated.

## Current Database Usage

The app uses Prisma session storage:

```ts
sessionStorage: new PrismaSessionStorage(prisma)
```

The current Prisma schema uses SQLite:

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:dev.sqlite"
}
```

The current database stores Shopify sessions only. It does not store wishlist records.

## Production Database Recommendation

SQLite should not be used inside AWS App Runner or ECS containers for production because the container filesystem is not durable across redeploys, restarts, or scaling.

Recommended production setup:

- Use Amazon RDS PostgreSQL for Shopify session storage.
- Update Prisma datasource to PostgreSQL.

Recommended Prisma datasource:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

## Recommended AWS Architecture

Use the following AWS services:

- AWS App Runner for hosting the web app container
- Amazon ECR for Docker images
- Amazon RDS PostgreSQL for Shopify session storage
- AWS Secrets Manager or SSM Parameter Store for secrets
- Amazon CloudWatch Logs for logs and debugging
- AWS Certificate Manager for SSL
- Route 53 or existing DNS provider for domain routing

App Runner is sufficient for the current app because the repo contains a single web service and no separate worker, queue, or cron process.

## Required Environment Variables

Configure these variables in AWS App Runner:

```env
NODE_ENV=production
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SCOPES=read_customers,write_customers,read_products,write_products
SHOPIFY_APP_URL=https://wishlist.yourdomain.com
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME
```

Optional:

```env
SHOP_CUSTOM_DOMAIN=...
```

Use `SHOP_CUSTOM_DOMAIN` only if the app needs to support a specific custom Shopify shop domain.

## Local Development

Install dependencies:

```bash
npm install
```

Run the Shopify development server:

```bash
npm run dev
```

Generate Prisma client and apply migrations:

```bash
npm run setup
```

Run type checks:

```bash
npm run typecheck
```

Run lint:

```bash
npm run lint
```

## Build

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm run start
```

Docker start command:

```bash
npm run docker-start
```

`docker-start` runs:

```bash
npm run setup && npm run start
```

## Docker Deployment

The repository includes a Dockerfile.

The container exposes port:

```dockerfile
EXPOSE 3000
```

The container command is:

```dockerfile
CMD ["npm", "run", "docker-start"]
```

When deploying to AWS App Runner, configure the service port as `3000`.

## Shopify Configuration

Current Shopify app config is in `shopify.app.toml`.

Current Render URL:

```toml
application_url = "https://darveys-wishlist.onrender.com/"
```

For AWS, update it to the new domain:

```toml
application_url = "https://wishlist.yourdomain.com"
```

Update auth redirect URL:

```toml
[auth]
redirect_urls = [ "https://wishlist.yourdomain.com/auth/callback" ]
```

The app proxy configuration should remain:

```toml
[app_proxy]
url = "/proxy/wishlist"
subpath = "wishlist"
prefix = "apps"
```

Storefront URL:

```text
https://store-domain.com/apps/wishlist
```

Shopify proxies that request to:

```text
https://wishlist.yourdomain.com/proxy/wishlist
```

Existing webhook routes:

```text
/webhooks/app/uninstalled
/webhooks/app/scopes_update
```

After updating `shopify.app.toml`, deploy the Shopify app configuration:

```bash
npm run deploy
```

## AWS Migration Steps

1. Create an Amazon ECR repository.
2. Create an Amazon RDS PostgreSQL database.
3. Update Prisma provider from SQLite to PostgreSQL.
4. Create and verify the Prisma migration for PostgreSQL.
5. Set `DATABASE_URL` for RDS.
6. Build the Docker image.
7. Push the Docker image to ECR.
8. Create an AWS App Runner service from the ECR image.
9. Configure App Runner service port as `3000`.
10. Add required environment variables and secrets.
11. Connect App Runner to RDS using a VPC connector if RDS is private.
12. Attach custom domain and SSL certificate.
13. Update `SHOPIFY_APP_URL`.
14. Update `shopify.app.toml` application URL and redirect URL.
15. Run `npm run deploy` to sync Shopify configuration.
16. Test the app on the AWS URL.
17. Switch DNS from Render to AWS.
18. Keep Render active during the rollback window.

## Testing Checklist

Before final cutover, verify:

- AWS app URL opens successfully.
- Embedded Shopify admin app loads inside Shopify admin.
- OAuth install or re-auth flow works.
- `/auth/callback` works.
- Storefront app proxy `/apps/wishlist` works.
- Logged-in customer can add a wishlist item.
- Logged-in customer can remove a wishlist item.
- Wishlist persists after page refresh.
- Wishlist data appears in Shopify customer metafield.
- App uninstall webhook works.
- Scopes update webhook works.
- CloudWatch logs are available.
- No Prisma or session storage errors appear in logs.

## Rollback Plan

Keep the Render service running for at least 24 to 48 hours after AWS migration.

Rollback steps:

1. Point DNS back to Render.
2. Revert Shopify `application_url` to:

```toml
application_url = "https://darveys-wishlist.onrender.com/"
```

3. Revert auth redirect URL to:

```toml
[auth]
redirect_urls = [ "https://darveys-wishlist.onrender.com/auth/callback" ]
```

4. Deploy Shopify configuration:

```bash
npm run deploy
```

5. Confirm storefront `/apps/wishlist` works again.

Wishlist data rollback is not required because wishlist data is stored in Shopify customer metafields.

## DevOps Notes

- Do not migrate wishlist records. There are no wishlist records in the app database.
- Wishlist data is stored in Shopify customer metafields.
- The app database is only for Shopify session storage.
- Replace SQLite with RDS PostgreSQL before AWS production deployment.
- App Runner is enough for the current application.
- ECS Fargate should only be considered if future requirements include workers, queues, cron jobs, or advanced networking.
- Keep Render active until AWS production is fully verified.
