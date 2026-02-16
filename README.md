whatsapp-clone-api/
│
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
│       │   └── 📄 .gitkeep
│       ├── 📂 videos/
│       │   └── 📄 .gitkeep
│       ├── 📂 audio/
│       │   └── 📄 .gitkeep
│       └── 📂 documents/
│           └── 📄 .gitkeep
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
│   │   ├── 📄 SQLiteStores.test.js
│   │   ├── 📄 SessionHandler.test.js
│   │   ├── 📄 SessionsManager.test.js
│   │   └── 📄 utils.test.js
│   │
│   ├── 📂 integration/
│   │   ├── 📄 api.test.js
│   │   ├── 📄 websocket.test.js
│   │   └── 📄 services.test.js
│   │
│   └── 📂 fixtures/
│       ├── 📄 mockData.js
│       └── 📄 testDb.js
│
├── 📂 docs/
│   ├── 📄 API.md
│   ├── 📄 WEBHOOKS.md
│   ├── 📄 DEPLOY.md
│   └── 📄 EXAMPLES.md
│
├── 📂 public/
│   ├── 📂 css/
│   │   └── 📄 style.css
│   ├── 📂 js/
│   │   └── 📄 app.js
│   ├── 📂 img/
│   │   └── 📄 favicon.ico
│   └── 📂 views/
│       ├── 📄 index.html
│       ├── 📄 dashboard.html
│       ├── 📄 login.html
│       ├── 📄 register.html
│       ├── 📄 session.html
│       ├── 📄 chat.html
│       ├── 📄 settings.html
│       ├── 📄 webhooks.html
│       ├── 📄 schedule.html
│       ├── 📄 auto-responder.html
│       └── 📄 admin.html
│
└── 📂 .github/
    ├── 📂 workflows/
    │   ├── 📄 ci.yml
    │   └── 📄 deploy.yml
    └── 📄 PULL_REQUEST_TEMPLATE.md