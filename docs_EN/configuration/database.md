# Database Configuration

## Supported Databases

The system currently supports two database types:

- **SQLite**: Default database, zero configuration
- **PostgreSQL**: Recommended for production deployments

## SQLite Configuration

### Default Configuration

SQLite is the default database and requires no extra setup.

### File Location
```
server/data/
├── app.db      # Application database
└── meta.db     # Metadata database
```

### Advantages
- Zero configuration
- Easy file-level backup
- Suitable for development and small teams

### Limitations
- Limited concurrent writes
- Not suitable for high-concurrency scenarios

## PostgreSQL Configuration

### Prerequisites

1. Install PostgreSQL server
2. Create a database and user

### Create Database
```sql
CREATE USER bola_user WITH PASSWORD 'your_password';
CREATE DATABASE bola_db OWNER bola_user;
GRANT ALL PRIVILEGES ON DATABASE bola_db TO bola_user;
```

### Create Database Profile

```http
POST /admin/db/profiles
Content-Type: application/json

{
  "name": "postgres_prod",
  "kind": "postgres",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "bola_db",
    "user": "bola_user",
    "password": "your_password",
    "ssl": false
  }
}
```

### Switch Database
```http
POST /admin/db/switch
Content-Type: application/json

{
  "profile_id": "<profile-id>"
}
```

## Data Migration

### Export Data
```http
POST /admin/db/export
```

### Import Data
```http
POST /admin/db/import
Content-Type: application/json

{
  "data": {
    "environments": [],
    "accounts": []
  },
  "target_profile_id": "<profile-id>"
}
```

## Common Questions

### Q: How do I back up the SQLite database?
A: Copy `server/data/app.db` to a safe location.

### Q: Can I use multiple databases simultaneously?
A: You can create multiple profiles, but only one is active at a time.

### Q: Will switching databases lose my data?
A: No. Switching only changes which database is currently active.

### Q: Can I connect to a remote PostgreSQL database?
A: Yes. Provide the remote host, port, credentials, and SSL settings in the database profile.

---

See [Environment Variables Configuration](environment-variables.md) for runtime variable guidance.
