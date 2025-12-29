import { Router, Request, Response } from 'express';
import { dbManager } from '../db/db-manager.js';
import type { DbKind, DbConfig } from '../types/index.js';

const router = Router();

router.get('/db/status', async (req: Request, res: Response) => {
  try {
    const status = await dbManager.getStatus();
    res.json({ data: status, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/db/profiles', async (req: Request, res: Response) => {
  try {
    const profiles = await dbManager.getProfiles();
    const sanitizedProfiles = profiles.map(p => ({
      ...p,
      config: {
        ...p.config,
        password: p.config.password ? '********' : undefined,
      },
    }));
    res.json({ data: sanitizedProfiles, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/db/profiles/:id', async (req: Request, res: Response) => {
  try {
    const profile = await dbManager.getProfile(req.params.id);
    if (!profile) {
      res.status(404).json({ data: null, error: 'Profile not found' });
      return;
    }
    const sanitizedProfile = {
      ...profile,
      config: {
        ...profile.config,
        password: profile.config.password ? '********' : undefined,
      },
    };
    res.json({ data: sanitizedProfile, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/db/profiles', async (req: Request, res: Response) => {
  try {
    const { name, kind, config } = req.body as {
      name: string;
      kind: DbKind;
      config: DbConfig;
    };

    if (!name || !kind || !config) {
      res.status(400).json({ data: null, error: 'name, kind, and config are required' });
      return;
    }

    const profile = await dbManager.createProfile({ name, kind, config });
    res.status(201).json({ data: profile, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.patch('/db/profiles/:id', async (req: Request, res: Response) => {
  try {
    const { name, config } = req.body;
    const profile = await dbManager.updateProfile(req.params.id, { name, config });

    if (!profile) {
      res.status(404).json({ data: null, error: 'Profile not found' });
      return;
    }

    res.json({ data: profile, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.delete('/db/profiles/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await dbManager.deleteProfile(req.params.id);

    if (!deleted) {
      res.status(404).json({ data: null, error: 'Profile not found' });
      return;
    }

    res.json({ data: { success: true }, error: null });
  } catch (error: any) {
    res.status(400).json({ data: null, error: error.message });
  }
});

router.post('/db/test-connection', async (req: Request, res: Response) => {
  try {
    const { kind, config } = req.body as {
      kind: DbKind;
      config: DbConfig;
    };

    if (!kind || !config) {
      res.status(400).json({ data: null, error: 'kind and config are required' });
      return;
    }

    const result = await dbManager.testConnection({ kind, config });
    res.json({ data: result, error: result.success ? null : result.error });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/db/migrate', async (req: Request, res: Response) => {
  try {
    const { profile_id } = req.body as { profile_id: string };

    if (!profile_id) {
      res.status(400).json({ data: null, error: 'profile_id is required' });
      return;
    }

    const result = await dbManager.migrateProfile(profile_id);
    res.json({ data: result, error: result.success ? null : result.error });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/db/switch', async (req: Request, res: Response) => {
  try {
    const { profile_id } = req.body as { profile_id: string };

    if (!profile_id) {
      res.status(400).json({ data: null, error: 'profile_id is required' });
      return;
    }

    const status = await dbManager.getStatus();
    if (status.runningRunsCount > 0) {
      res.status(409).json({
        data: null,
        error: `Cannot switch: ${status.runningRunsCount} running runs exist. Please wait for them to complete.`,
      });
      return;
    }

    const result = await dbManager.switchTo(profile_id);

    if (!result.success) {
      res.status(400).json({ data: null, error: result.error });
      return;
    }

    const newStatus = await dbManager.getStatus();
    res.json({ data: { success: true, status: newStatus }, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/db/export', async (req: Request, res: Response) => {
  try {
    const data = await dbManager.exportData();
    res.json({ data, error: null });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

router.post('/db/import', async (req: Request, res: Response) => {
  try {
    const { data, target_profile_id } = req.body as {
      data: Record<string, any[]>;
      target_profile_id?: string;
    };

    if (!data) {
      res.status(400).json({ data: null, error: 'data is required' });
      return;
    }

    const result = await dbManager.importData(data, target_profile_id);
    res.json({ data: result, error: result.success ? null : result.error });
  } catch (error: any) {
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
