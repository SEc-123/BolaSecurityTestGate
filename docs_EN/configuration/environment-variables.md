# Environment Variables Configuration

## Frontend Environment Variables

The frontend uses Vite's environment variable system. All variables must be prefixed with `VITE_`.

### Configuration File

File location: `/.env`

### Variable List

| Variable Name | Type | Required | Description | Default Value |
|--------------|------|----------|-------------|---------------|
| `VITE_API_URL` | string | Yes | Backend API address | `http://localhost:3001` |

### Configuration Examples

**.env (Development)**:
```env
VITE_API_URL=http://localhost:3001
```

**.env.production (Production)**:
```env
VITE_API_URL=https://api.yourdomain.com
```

## Backend Environment Variables

The backend uses standard Node.js environment variables.

### Configuration File

File location: `/server/.env` (optional, but not auto-loaded by the backend)

### Variable List

| Variable Name | Type | Required | Description | Default Value |
|--------------|------|----------|-------------|---------------|
| `PORT` | number | No | Backend server port | `3001` |
| `NODE_ENV` | string | No | Runtime environment | `development` |
| `DB_TYPE` | string | No | Database type hint for deployment tooling | `sqlite` |
| `DB_PATH` | string | No | SQLite database path | `./data/app.db` |
| `POSTGRES_HOST` | string | No | PostgreSQL host | - |
| `POSTGRES_PORT` | number | No | PostgreSQL port | `5432` |
| `POSTGRES_DB` | string | No | PostgreSQL database name | - |
| `POSTGRES_USER` | string | No | PostgreSQL username | - |
| `POSTGRES_PASSWORD` | string | No | PostgreSQL password | - |
| `POSTGRES_SSL` | boolean | No | Enable PostgreSQL SSL | `false` |

### Configuration Examples

**server/.env (Development - SQLite)**:
```env
PORT=3001
NODE_ENV=development
DB_TYPE=sqlite
DB_PATH=./data/app.db
```

**server/.env (Production - PostgreSQL)**:
```env
PORT=3001
NODE_ENV=production
DB_TYPE=postgres
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_DB=bola_prod
POSTGRES_USER=bola_user
POSTGRES_PASSWORD=strong_password
POSTGRES_SSL=true
```

## Accessing Environment Variables in Code

### Frontend (Vite + React)
```typescript
const apiUrl = import.meta.env.VITE_API_URL;

if (!import.meta.env.VITE_API_URL) {
  console.error('VITE_API_URL is not defined');
}
```

### Backend (Node.js)
```typescript
const port = process.env.PORT || 3001;
const nodeEnv = process.env.NODE_ENV || 'development';

if (!process.env.DB_PATH && process.env.DB_TYPE === 'sqlite') {
  console.error('DB_PATH is not defined');
}
```

## Best Practices

### 1. Never Commit .env Files
Add `.env` to your `.gitignore` file:
```gitignore
.env
.env.local
.env.production
```

### 2. Use .env.example as Template
Create a `.env.example` file with placeholder values:
```env
VITE_API_URL=http://localhost:3001
PORT=3001
```

### 3. Document All Variables
Maintain documentation for all environment variables in this file or in your README.

### 4. Use Different Files for Different Environments
- `.env`: Default for development
- `.env.production`: Production configuration
- `.env.test`: Test environment configuration

### 5. Validate Required Variables at Startup
Check for required variables when the application starts and fail fast if any are missing.

## Common Questions

### Q: Why aren't my environment variable changes taking effect?
A: You need to restart the development server. Frontend variables must start with `VITE_`.

### Q: Should .env files be committed to Git?
A: No. Use `.env.example` as a template and add `.env` to `.gitignore`.

### Q: How do I access environment variables in my code?
A:
- Frontend: `import.meta.env.VITE_API_URL`
- Backend: `process.env.PORT`

### Q: Can I use environment variables in production builds?
A: Yes, Vite inlines `VITE_` variables at build time for the frontend. Backend variables are read at runtime.

### Q: What happens if a required environment variable is missing?
A: The application should validate required variables at startup and fail with a clear error message.

---

**Next**: Check out [Database Configuration](database.md) for database setup instructions.
