# Deploying the Curb sync server

Targets `server.lawrencehook.com`, deployed alongside the other apps in `~/github/deployments`. Path prefix `/curb/`, port `3006`.

## 1. Changes to make in `~/github/deployments`

### `etc/nginx/conf.d/apps.conf`

Replace the entire file with the version below. This:
- Backports the TLS / redirect blocks that certbot has already added on the host (the snapshot in the repo is HTTP-only — it's stale).
- Adds the new `/curb/ → localhost:3006` location.

Keep the `# managed by Certbot` comments and the `if ($host = ...)` redirect intact. Certbot recognizes its own marks and will leave them alone on cert renewal; if you reformat them, it may rewrite the file.

```nginx
server {
    server_name server.lawrencehook.com _;

    location /test/ {
        proxy_pass http://localhost:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://localhost:3002/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /SqueexVodSearch/ {
        proxy_pass http://localhost:3003/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /HeadgumPodcastSearch/ {
        proxy_pass http://localhost:3004/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /rys/ {
        proxy_pass http://localhost:3005/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /curb/ {
        proxy_pass http://localhost:3006/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/server.lawrencehook.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/server.lawrencehook.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = server.lawrencehook.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name server.lawrencehook.com _;
    return 404; # managed by Certbot
}
```

### `run`

Append:

```bash
# Curb sync server
cd /home/ec2-user/github/curb && git checkout -- . && git pull;
cd server && npm install && npm audit fix;
pm2 restart curb-sync || pm2 start src/index.js --name curb-sync;
```

Commit + push the deployments repo when both edits are in.

## 2. One-time setup on the EC2 host

### Verify the live nginx file matches the backport

Before applying via `update_nginx_conf.sh`, sanity check the diff:

```bash
cd ~/github/deployments && git pull
diff /etc/nginx/conf.d/apps.conf etc/nginx/conf.d/apps.conf
```

The only differences should be the new `/curb/` block. If anything else differs, reconcile before continuing.

### Confirm SES sender identity

Convention: `curb_noreply@lawrencehook.com`.

In the AWS SES console (us-east-1), confirm that `lawrencehook.com` is verified at the **domain** level (DKIM records in DNS). If so, `curb_noreply@` works without extra steps.

If only individual addresses are verified, verify `curb_noreply@lawrencehook.com` separately first.

### Clone the curb repo

```bash
cd ~/github
git clone git@github.com:lawrencehook/curb.git
```

### Confirm S3 access

Sync documents live in `s3://curb-extension/curb/<email>.json`. Confirm the IAM user behind the existing AWS creds has these permissions on the bucket:

```
s3:GetObject     arn:aws:s3:::curb-extension/curb/*
s3:PutObject     arn:aws:s3:::curb-extension/curb/*
```

(`HeadObject` isn't strictly required — `GetObject` covers the existence check.)

### Create the server `.env`

```bash
cd ~/github/curb/server
cat > .env <<EOF
PORT=3006
BASE_URL=https://server.lawrencehook.com/curb
JWT_SECRET=$(openssl rand -hex 32)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<reuse RYS creds>
AWS_SECRET_ACCESS_KEY=<reuse RYS creds>
EMAIL_FROM=curb_noreply@lawrencehook.com
S3_BUCKET=curb-extension
DATA_DIR=/home/ec2-user/curb-data
EOF
chmod 600 .env
mkdir -p /home/ec2-user/curb-data
```

`DATA_DIR` lives outside the git checkout on purpose — `git checkout -- .` in the deploy script would otherwise clobber `storage.db` if it sat under `server/data/`. (Note: `storage.db` now only holds login codes and rate-limit counters — sync documents are in S3.)

### Apply the nginx update

```bash
bash ~/github/deployments/update_nginx_conf.sh
```

The script runs `cp` then `systemctl restart nginx`. If `nginx -t` fails on the new config, the restart will fail visibly.

### First server start

```bash
cd ~/github/curb/server
npm install
pm2 start src/index.js --name curb-sync
pm2 save                   # persist process list across reboots
```

(If `pm2 startup` hasn't been configured on this box yet for systemd boot persistence, run it once and follow the printed instructions.)

## 3. Smoke tests

From the EC2 box:
```bash
curl https://server.lawrencehook.com/curb/health
# expect: {"status":"ok","timestamp":"..."}
```

From your laptop:
```bash
curl -X POST https://server.lawrencehook.com/curb/auth/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"<your real email>"}'
# expect: {"ok":true} and an actual code email shortly after
```

Then in the extension's Settings → Sync card: enter the email, paste the code, watch sync happen.

## 4. Subsequent deploys

Once `~/github/deployments/run` has the curb stanza, redeploys are just:

```bash
bash ~/github/deployments/run
```

No nginx changes needed unless you alter routing.

## 5. Backups

Sync documents live in `s3://curb-extension/curb/`. Enable [S3 versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) on the bucket if you want history; AWS handles durability and accidental-overwrite recovery from there.

`storage.db` holds only ephemeral state (login codes + rate limits). It's recreatable — losing it just means anyone with an in-flight code has to request a fresh one. If you still want a snapshot:

```bash
sqlite3 /home/ec2-user/curb-data/storage.db ".backup /home/ec2-user/curb-data/backup-$(date +%F).db"
```

Throw a cron job at it nightly + rsync the result to S3 once usage warrants. SQLite WAL mode plays nicely with `.backup`.
