import * as cloud from "@pulumi/cloud";

/**
 * A simple interface for a 'table' of data.
 * Meant to be able to be shared across in-memory implementations and @pulumi/cloud.Table.
 * As much as possible, it tries to be a subset of @pulumi/cloud.Table
 */
export interface ISimpleTable<Entity> extends Partial<cloud.Table> {
  /** Get entity by id */
  get(query: { id: string }): Promise<Entity>;
  /** Add a new entity */
  insert(e: Entity): Promise<void>;
  /** Get all entities */
  scan(): Promise<Entity[]>;
  scan(callback: (items: Entity[]) => Promise<boolean>): Promise<void>;
}

interface IHasId {
  /** id of object */
  id: string;
}

/** Implementation of ISimpleTable that stores data in-memory in a Map */
export const MapSimpleTable = <Entity extends IHasId>(
  map = new Map<string, Entity>(),
): ISimpleTable<Entity> => {
  type ScanCallback = (entities: Entity[]) => Promise<boolean>;
  // tslint:disable:completed-docs
  async function scan(): Promise<Entity[]>;
  async function scan(callback: ScanCallback): Promise<undefined>;
  async function scan(callback?: ScanCallback) {
    if (callback) {
      for (const e of map.values()) {
        callback([e]);
      }
      return;
    } else {
      const values = Array.from(map.values());
      return values;
    }
  }
  // tslint:enable:completed-docs
  return {
    async get(query: { id: string }) {
      const got = map.get(query.id);
      if (!got) {
        throw new Error(`Entity not found for id=${query.id}`);
      }
      return got;
    },
    async insert(entity: Entity) {
      map.set(entity.id, entity);
    },
    scan,
  };
};
