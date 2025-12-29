import { Router, Request, Response } from 'express';
import type { Repository } from '../types/index.js';
import { dbManager } from '../db/db-manager.js';

type RepoGetter<T> = () => Repository<T>;

export function createCrudRouter<T extends { id: string }>(
  repoGetter: RepoGetter<T>,
  options: {
    allowCreate?: boolean;
    allowUpdate?: boolean;
    allowDelete?: boolean;
    beforeCreate?: (data: any, req: Request) => Promise<any>;
    afterCreate?: (item: T, req: Request) => Promise<void>;
    beforeUpdate?: (id: string, data: any, req: Request) => Promise<any>;
    afterUpdate?: (item: T, req: Request) => Promise<void>;
    beforeDelete?: (id: string, req: Request) => Promise<void>;
    afterDelete?: (id: string, req: Request) => Promise<void>;
  } = {}
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const repo = repoGetter();
      const { limit, offset, ...where } = req.query;

      const items = await repo.findAll({
        where: Object.keys(where).length > 0 ? where as any : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({ data: items, error: null });
    } catch (error: any) {
      res.status(500).json({ data: null, error: error.message });
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const repo = repoGetter();
      const item = await repo.findById(req.params.id);

      if (!item) {
        res.status(404).json({ data: null, error: 'Not found' });
        return;
      }

      res.json({ data: item, error: null });
    } catch (error: any) {
      res.status(500).json({ data: null, error: error.message });
    }
  });

  if (options.allowCreate !== false) {
    router.post('/', async (req: Request, res: Response) => {
      try {
        const repo = repoGetter();
        let data = req.body;

        if (options.beforeCreate) {
          data = await options.beforeCreate(data, req);
        }

        const item = await repo.create(data);

        if (options.afterCreate) {
          await options.afterCreate(item, req);
        }

        res.status(201).json({ data: item, error: null });
      } catch (error: any) {
        res.status(500).json({ data: null, error: error.message });
      }
    });
  }

  if (options.allowUpdate !== false) {
    router.patch('/:id', async (req: Request, res: Response) => {
      try {
        const repo = repoGetter();
        const { id } = req.params;
        let data = req.body;

        if (options.beforeUpdate) {
          data = await options.beforeUpdate(id, data, req);
        }

        const item = await repo.update(id, data);

        if (!item) {
          res.status(404).json({ data: null, error: 'Not found' });
          return;
        }

        if (options.afterUpdate) {
          await options.afterUpdate(item, req);
        }

        res.json({ data: item, error: null });
      } catch (error: any) {
        res.status(500).json({ data: null, error: error.message });
      }
    });

    router.put('/:id', async (req: Request, res: Response) => {
      try {
        const repo = repoGetter();
        const { id } = req.params;
        let data = req.body;

        if (options.beforeUpdate) {
          data = await options.beforeUpdate(id, data, req);
        }

        const item = await repo.update(id, data);

        if (!item) {
          res.status(404).json({ data: null, error: 'Not found' });
          return;
        }

        if (options.afterUpdate) {
          await options.afterUpdate(item, req);
        }

        res.json({ data: item, error: null });
      } catch (error: any) {
        res.status(500).json({ data: null, error: error.message });
      }
    });
  }

  if (options.allowDelete !== false) {
    router.delete('/:id', async (req: Request, res: Response) => {
      try {
        const repo = repoGetter();
        const { id } = req.params;

        if (options.beforeDelete) {
          await options.beforeDelete(id, req);
        }

        const deleted = await repo.delete(id);

        if (!deleted) {
          res.status(404).json({ data: null, error: 'Not found' });
          return;
        }

        if (options.afterDelete) {
          await options.afterDelete(id, req);
        }

        res.json({ data: { success: true }, error: null });
      } catch (error: any) {
        res.status(500).json({ data: null, error: error.message });
      }
    });
  }

  return router;
}
