# WhatsApp Clone API  

Complete WhatsApp Web API Clone with Multi-Session Support, Role-Based Access Control, and n8n Integration.

---

## 🚀 Features

- **Multi-User Support** – Multiple users with role-based access  
- **Multi-Session** – Multiple WhatsApp sessions per user  
- **Real-time WebSocket** – Live updates for all events  
- **Webhook Integration** – Send events to n8n for automation  
- **Role-Based Access** – SuperAdmin, Admin, Moderator, User, Subscriber  
- **Complete WhatsApp Features** – Messages, Groups, Calls, Labels, Newsletters  
- **SQLite Database** – Lightweight with WAL mode for performance  
- **Media Handling** – Upload and download images, videos, audio, documents  
- **Backup System** – Automatic and manual backups  
- **Activity Logging** – Complete audit trail  
- **Rate Limiting** – Per-user and global rate limits  
- **Session Management** – Create, monitor, and terminate sessions  

---

## 📋 Prerequisites

- Node.js 18+  
- npm 9+  
- SQLite3  

---

## 🛠️ Installation

```bash
# Clone repository
git clone https://github.com/imskriaz/whatsapp-clone-api.git
cd whatsapp-clone-api

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run setup (creates admin user)
npm run setup

# Start development server
npm run dev
```

---

## 🏗️ Project Structure

```
├── 📄 app.js
├── 📄 package.json
├── 📄 package-lock.json
├── 📄 .env
├── 📄 .env.example
├── 📄 .gitignore
├── 📄 README.md
├── 📄 LICENSE
├── 📄 docker-compose.yml
├── 📄 Dockerfile
├── 📄 ecosystem.config.js
├── 📄 .eslintrc.js
├── 📄 .prettierrc
├── 📄 jest.config.js
│
├── 📂 src/
│   ├── 📂 core/
│   │   ├── 📄 SQLiteStores.js
│   │   ├── 📄 SessionHandler.js
│   │   └── 📄 SessionsManager.js
│   │
│   ├── 📂 api/
│   │   ├── 📄 routes.js
│   │   └── 📄 middleware.js
│   │
│   ├── 📂 services/
│   │   ├── 📄 webhook.js
│   │   ├── 📄 scheduler.js
│   │   ├── 📄 responder.js
│   │   ├── 📄 backup.js
│   │   ├── 📄 cleanup.js
│   │   └── 📄 index.js
│   │
│   ├── 📂 websocket/
│   │   ├── 📄 server.js
│   │   └── 📄 handlers.js
│   │
│   ├── 📂 utils/
│   │   ├── 📄 logger.js
│   │   ├── 📄 helpers.js
│   │   ├── 📄 constants.js
│   │   └── 📄 encryption.js
│   │
│   └── 📂 config/
│       ├── 📄 db.js
│       └── 📄 server.js
│
├── 📂 data/
│   ├── 📄 db.db
│   ├── 📂 backups/
│   │   └── 📄 .gitkeep
│   └── 📂 media/
│       ├── 📂 images/
│       ├── 📂 videos/
│       ├── 📂 audio/
│       └── 📂 documents/
│
├── 📂 logs/
│   ├── 📄 .gitkeep
│   └── 📄 .gitignore
│
├── 📂 scripts/
│   ├── 📄 setup.js
│   ├── 📄 migrate.js
│   └── 📄 seed.js
│
├── 📂 tests/
│   ├── 📂 unit/
│   ├── 📂 integration/
│   └── 📂 fixtures/
│
├── 📂 docs/
│   ├── 📄 API.md
│   ├── 📄 WEBHOOKS.md
│   ├── 📄 DEPLOY.md
│   └── 📄 EXAMPLES.md
│
├── 📂 public/
│   ├── 📂 css/
│   ├── 📂 js/
│   ├── 📂 img/
│   └── 📂 views/
│
└── 📂 .github/
    ├── 📂 workflows/
    │   ├── 📄 ci.yml
    │   └── 📄 deploy.yml
    └── 📄 PULL_REQUEST_TEMPLATE.md
```

---

## 🔑 Role-Based Access

| Role         | Permissions |
|--------------|------------|
| SuperAdmin   | Full system access, manage users, manage sessions, all features |
| Admin        | Manage system, view everything, moderate content |
| Moderator    | Moderate WhatsApp content, send messages, manage groups |
| User         | Send messages, read messages, use features |
| Subscriber   | Read-only access |

---

## 📡 API Endpoints

### Public Routes
- `POST /api/register` – Register new user  
- `POST /api/login` – Login user  
- `GET /api/health` – Health check  

### User Routes
- `GET /api/user`
- `PUT /api/user/password`
- `POST /api/user/reset-key`
- `GET /api/user/meta`
- `POST /api/user/meta`

### Admin Routes
- `GET /api/admin/users`
- `GET /api/admin/users/:username`
- `PUT /api/admin/users/:username`
- `DELETE /api/admin/users/:username`
- `POST /api/admin/users/:username/meta`

### Session Routes
- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:sid`
- `DELETE /api/sessions/:sid`
- `POST /api/sessions/:sid/logout`
- `GET /api/sessions/:sid/qr`

### Chat Routes
- `GET /api/sessions/:sid/chats`
- `GET /api/sessions/:sid/chats/:jid`
- `PUT /api/sessions/:sid/chats/:jid`
- `DELETE /api/sessions/:sid/chats/:jid`

### Message Routes
- `GET /api/sessions/:sid/chats/:jid/messages`
- `GET /api/sessions/:sid/messages/:msgId`
- `POST /api/sessions/:sid/messages/:msgId/star`
- `DELETE /api/sessions/:sid/messages/:msgId`

### Send Routes
- `POST /api/sessions/:sid/send/text`
- `POST /api/sessions/:sid/send/media`
- `POST /api/sessions/:sid/send/location`
- `POST /api/sessions/:sid/send/contact`
- `POST /api/sessions/:sid/send/reaction`
- `POST /api/sessions/:sid/send/bulk`

### Group Routes
- `POST /api/sessions/:sid/groups`
- `GET /api/sessions/:sid/groups`
- `GET /api/sessions/:sid/groups/:jid`
- `GET /api/sessions/:sid/groups/:jid/members`
- `PUT /api/sessions/:sid/groups/:jid/subject`
- `PUT /api/sessions/:sid/groups/:jid/description`
- `POST /api/sessions/:sid/groups/:jid/add`
- `POST /api/sessions/:sid/groups/:jid/remove`
- `POST /api/sessions/:sid/groups/:jid/promote`
- `POST /api/sessions/:sid/groups/:jid/demote`

### Profile Routes
- `PUT /api/sessions/:sid/profile/name`
- `PUT /api/sessions/:sid/profile/status`
- `POST /api/sessions/:sid/profile/picture`
- `DELETE /api/sessions/:sid/profile/picture`

### Webhook Routes
- `POST /api/sessions/:sid/webhooks`
- `GET /api/sessions/:sid/webhooks`
- `DELETE /api/sessions/:sid/webhooks/:id`
- `POST /api/sessions/:sid/webhooks/:id/test`

### Backup Routes
- `POST /api/sessions/:sid/backup`
- `GET /api/sessions/:sid/backups`

---

## 🔌 n8n Integration

Webhook Events:
- `message`
- `presence`
- `chat`
- `reaction`
- `group`
- `call`

Example n8n Workflow:

```json
{
  "name": "WhatsApp Auto-Responder",
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhookTrigger",
      "parameters": {
        "path": "whatsapp"
      }
    },
    {
      "name": "IF",
      "type": "n8n-nodes-base.if",
      "parameters": {
        "conditions": {
          "string": [
            {
              "value1": "={{$json.data.text}}",
              "operation": "contains",
              "value2": "hello"
            }
          ]
        }
      }
    },
    {
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "http://localhost:3000/api/sessions/{{$json.sessionId}}/send/text",
        "headers": {
          "x-api-key": "={{$env.API_KEY}}"
        },
        "body": {
          "jid": "={{$json.data.from}}",
          "text": "Hello! How can I help you?"
        }
      }
    }
  ]
}
```

---

## 🚀 Deployment

### Using PM2

```bash
npm install -g pm2
npm run pm2
npm run pm2:monit
npm run pm2:logs
```

### Using Docker

```bash
npm run docker:build
npm run docker:run
npm run docker:compose
```

### Using systemd

Create `/etc/systemd/system/whatsapp-clone.service`:

```ini
[Unit]
Description=WhatsApp Clone API
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/whatsapp-clone-api
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 🔒 Security

- API key authentication  
- Role-based access control  
- Rate limiting per user/IP  
- Input validation  
- SQL injection prevention  
- XSS protection  
- CORS configuration  
- Helmet.js security headers  

---

## 🧪 Testing

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
```

---

## 📄 License

MIT License – see LICENSE file

---

## 🙏 Acknowledgments

- WhiskeySockets/Baileys – WhatsApp Web API  
- n8n.io – Workflow automation  
- Express – Web framework  
- SQLite – Database  

---

## 📞 Support

- GitHub Issues  
- Discord Community  
- Email: support@whatsapp-clone.com
