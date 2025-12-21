# Admin API Consistency Verification

This document verifies the consistency between frontend API client, backend routes, and database manager.

## Database Profile Management APIs

### ✅ Update Profile

**Frontend (api-client.ts:489-494):**
```typescript
async updateProfile(id: string, updates: Partial<DbProfile>): Promise<DbProfile> {
  return apiRequest<DbProfile>(`/admin/db/profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}
```

**Backend Route (admin.ts:72-86):**
```typescript
router.patch('/db/profiles/:id', async (req: Request, res: Response) => {
  const { name, config } = req.body;
  const profile = await dbManager.updateProfile(req.params.id, { name, config });
  // ...
});
```

**Database Manager (db-manager.ts:131-142):**
```typescript
async updateProfile(id: string, data: Partial<{ name: string; config: DbConfig }>): Promise<DbProfile | null> {
  // Implementation
}
```

**Status:** ✅ Consistent
- Method: PATCH
- Parameter: ID from URL path
- Updates: Passed in request body

---

### ✅ Migrate Profile

**Frontend (api-client.ts:510-515):**
```typescript
async migrateProfile(profileId: string): Promise<{ success: boolean; error?: string; schemaVersion?: string }> {
  return apiRequest('/admin/db/migrate', {
    method: 'POST',
    body: JSON.stringify({ profile_id: profileId }),
  });
}
```

**Backend Route (admin.ts:122-136):**
```typescript
router.post('/db/migrate', async (req: Request, res: Response) => {
  const { profile_id } = req.body as { profile_id: string };
  // ...
  const result = await dbManager.migrateProfile(profile_id);
  // ...
});
```

**Database Manager (db-manager.ts:190-210):**
```typescript
async migrateProfile(profileId: string): Promise<{ success: boolean; error?: string; schemaVersion?: string }> {
  // Implementation
}
```

**Status:** ✅ Consistent
- Method: POST
- Parameter: `profile_id` from request body
- Returns: `{ success, error?, schemaVersion? }`

---

## Design Rationale

### Why PATCH for updateProfile?
- PATCH is semantically correct for partial updates
- RESTful convention: PATCH for partial modifications, PUT for full replacements
- We only update specific fields (name, config), not the entire profile

### Why POST with body for migrateProfile?
- Migration is an action/operation, not a resource update
- POST is appropriate for operations that trigger side effects
- Body parameter allows for potential future extension (e.g., migration options)
- Consistent with other operation endpoints (testConnection, switchProfile, export, import)

---

## Other Admin Endpoints

All endpoints follow consistent patterns:

| Endpoint | Method | Parameters | Purpose |
|----------|--------|------------|---------|
| GET /db/status | GET | - | Get database status |
| GET /db/profiles | GET | - | List all profiles |
| GET /db/profiles/:id | GET | :id | Get specific profile |
| POST /db/profiles | POST | body | Create new profile |
| PATCH /db/profiles/:id | PATCH | :id, body | Update profile |
| DELETE /db/profiles/:id | DELETE | :id | Delete profile |
| POST /db/test-connection | POST | body | Test connection |
| POST /db/migrate | POST | body | Migrate database schema |
| POST /db/switch | POST | body | Switch active profile |
| POST /db/export | POST | - | Export data |
| POST /db/import | POST | body | Import data |

**Pattern:**
- GET: Retrieval operations, parameters in URL
- POST: Creation and action operations, parameters in body
- PATCH: Partial updates, ID in URL, changes in body
- DELETE: Removal operations, ID in URL

---

## Verification Date

Last verified: 2025-12-20

## Conclusion

✅ All admin API endpoints are consistent between frontend, backend routes, and database manager.
✅ HTTP method choices follow RESTful conventions.
✅ Parameter passing is consistent and predictable.
