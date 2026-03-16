# Database Configuration

## Supported Databases

The system supports three database types:

- **SQLite**: Default database, zero configuration
- **PostgreSQL**: Recommended for production
- **Supabase**: Cloud-hosted PostgreSQL

## SQLite Configuration

### Default Configuration

SQLite is the default database and requires no configuration to use.

### File Location
```
server/data/
├── app.db      # Application database
└── meta.db     # Metadata database
```

### Advantages
- Zero configuration, works out of the box
- File-level backups
- Suitable for development and small teams

### Limitations
- Limited concurrent writes
- Not suitable for high-concurrency scenarios

## PostgreSQL Configuration

### Prerequisites

1. Install PostgreSQL server
2. Create database and user

### Create Database
```sql
CREATE USER bola_user WITH PASSWORD 'your_password';
CREATE DATABASE bola_db OWNER bola_user;
GRANT ALL PRIVILEGES ON DATABASE bola_db TO bola_user;
```

### Create Database Profile

```http
POST /admin/db-profiles
Content-Type: application/json

{
  "profile_name": "postgres_prod",
  "provider_type": "postgres",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "bola_db",
    "user": "bola_user",
    "password": "your_password"
  }
}
```

### Switch Database
```http
POST /admin/db-profiles/switch
Content-Type: application/json

{
  "profile_name": "postgres_prod"
}
```

## Supabase Configuration

### Get Connection Information

1. Log in to Supabase Dashboard
2. Go to Settings → Database
3. Copy Connection String

### Create Supabase Profile

```http
POST /admin/db-profiles
Content-Type: application/json

{
  "profile_name": "supabase_cloud",
  "provider_type": "postgres",
  "config": {
    "host": "db.xxx.supabase.co",
    "port": 5432,
    "database": "postgres",
    "user": "postgres",
    "password": "your_supabase_password",
    "ssl": true
  }
}
```

## Data Migration

### Export Data
```http
GET /admin/export
```

**Response**: JSON containing all data from the current database.

### Import Data
```http
POST /admin/import
Content-Type: application/json

{
  "environments": [...],
  "accounts": [...],
  "templates": [...],
  "checklists": [...]
}
```

## Database Profiles Management

### List All Profiles
```http
GET /admin/db-profiles
```

### Get Active Profile
```http
GET /admin/db-profiles/active
```

### Delete Profile
```http
DELETE /admin/db-profiles/:profile_name
```

## Common Questions

### Q: How do I backup SQLite database?
A: Simply copy the `server/data/app.db` file to a safe location.

### Q: Can I use multiple databases simultaneously?
A: You can create multiple profiles, but only one is active at a time.

### Q: Will switching databases lose my data?
A: No, switching only changes which database is currently in use. Original data remains unchanged.

### Q: Can I connect to a remote PostgreSQL database?
A: Yes, specify the remote host and port in the database profile configuration.

### Q: How do I migrate from SQLite to PostgreSQL?
A: 
1. Export data from SQLite using `/admin/export`
2. Create PostgreSQL database profile
3. Switch to PostgreSQL profile
4. Import data using `/admin/import`

---

**Next**: Check out [Environment Variables](environment-variables.md) for configuration options.
