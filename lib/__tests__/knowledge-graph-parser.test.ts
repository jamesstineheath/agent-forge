import { describe, it, expect, beforeAll } from 'vitest';
import { parseFile, ParseResult } from '../knowledge-graph/parser';
import type { CodeEntity, CodeRelationship } from '../knowledge-graph/types';

const FIXTURE = `
/**
 * Adds two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function noDoc(x: string): void {
  console.log(x);
}

/** Represents an animal. */
export class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class Dog extends Animal implements Serializable {
  bark(): void {}
}

export interface Serializable {
  serialize(): string;
}

export type ID = string | number;

export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
}

export const MAX_RETRIES = 3;

export const multiply = (x: number, y: number): number => x * y;

/** A base entity */
export interface BaseEntity {
  id: string;
}

export interface NamedEntity extends BaseEntity {
  name: string;
}

// Not exported — should NOT appear in entities
const internalSecret = 'hidden';
function privateHelper(): void {}
`;

describe('parseFile', () => {
  let result: ParseResult;

  beforeAll(() => {
    result = parseFile('src/example.ts', FIXTURE, 'my-repo');
  });

  it('returns entities and localRelationships arrays', () => {
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('localRelationships');
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.localRelationships)).toBe(true);
  });

  describe('FunctionDeclaration', () => {
    let addFn: CodeEntity | undefined;

    beforeAll(() => {
      addFn = result.entities.find((e) => e.name === 'add' && e.type === 'function');
    });

    it('extracts function declaration', () => {
      expect(addFn).toBeDefined();
    });

    it('has correct type', () => {
      expect(addFn?.type).toBe('function');
    });

    it('has correct signature with parameter types and return type', () => {
      expect(addFn?.signature).toContain('number');
      expect(addFn?.signature).toContain('a');
      expect(addFn?.signature).toContain('b');
    });

    it('has correct line numbers (startLine < endLine)', () => {
      expect(addFn?.startLine).toBeGreaterThan(0);
      expect(addFn?.endLine).toBeGreaterThanOrEqual(addFn!.startLine);
    });

    it('extracts JSDoc docstring', () => {
      expect(addFn?.docstring).toBeTruthy();
      expect(addFn?.docstring).toContain('Adds two numbers');
    });

    it('has stable deterministic ID', () => {
      expect(addFn?.id).toBe('my-repo:src/example.ts:function:add');
    });

    it('extracts noDoc function without docstring', () => {
      const fn = result.entities.find((e) => e.name === 'noDoc');
      expect(fn).toBeDefined();
      expect(fn?.docstring).toBeFalsy();
    });
  });

  describe('ClassDeclaration', () => {
    it('extracts Animal class', () => {
      const animal = result.entities.find((e) => e.name === 'Animal' && e.type === 'class');
      expect(animal).toBeDefined();
      expect(animal?.startLine).toBeGreaterThan(0);
    });

    it('extracts Animal class JSDoc', () => {
      const animal = result.entities.find((e) => e.name === 'Animal' && e.type === 'class');
      expect(animal?.docstring).toContain('animal');
    });

    it('extracts Dog class with extends relationship', () => {
      const dog = result.entities.find((e) => e.name === 'Dog' && e.type === 'class');
      expect(dog).toBeDefined();
      const extendsRel = result.localRelationships.find(
        (r) => r.sourceId === dog?.id && r.type === 'extends',
      );
      expect(extendsRel).toBeDefined();
      // Animal is in the same file, so targetId should be resolved
      const animal = result.entities.find((e) => e.name === 'Animal');
      expect(extendsRel?.targetId).toBe(animal?.id);
    });

    it('extracts Dog class with implements relationship', () => {
      const dog = result.entities.find((e) => e.name === 'Dog' && e.type === 'class');
      const implementsRel = result.localRelationships.find(
        (r) => r.sourceId === dog?.id && r.type === 'implements',
      );
      expect(implementsRel).toBeDefined();
      const serializable = result.entities.find((e) => e.name === 'Serializable');
      expect(implementsRel?.targetId).toBe(serializable?.id);
    });
  });

  describe('InterfaceDeclaration', () => {
    it('extracts Serializable interface', () => {
      const iface = result.entities.find((e) => e.name === 'Serializable' && e.type === 'type');
      expect(iface).toBeDefined();
      expect(iface?.id).toBe('my-repo:src/example.ts:type:Serializable');
    });

    it('extracts interface extends relationship', () => {
      const namedEntity = result.entities.find((e) => e.name === 'NamedEntity');
      expect(namedEntity).toBeDefined();
      const extendsRel = result.localRelationships.find(
        (r) => r.sourceId === namedEntity?.id && r.type === 'extends',
      );
      expect(extendsRel).toBeDefined();
      const baseEntity = result.entities.find((e) => e.name === 'BaseEntity');
      expect(extendsRel?.targetId).toBe(baseEntity?.id);
    });
  });

  describe('TypeAliasDeclaration', () => {
    it('extracts ID type alias', () => {
      const typeAlias = result.entities.find((e) => e.name === 'ID' && e.type === 'type');
      expect(typeAlias).toBeDefined();
      expect(typeAlias?.startLine).toBeGreaterThan(0);
    });
  });

  describe('EnumDeclaration', () => {
    it('extracts Direction enum', () => {
      const en = result.entities.find((e) => e.name === 'Direction' && e.type === 'type');
      expect(en).toBeDefined();
      expect(en?.id).toBe('my-repo:src/example.ts:type:Direction');
    });
  });

  describe('VariableStatement', () => {
    it('extracts exported variable MAX_RETRIES', () => {
      const v = result.entities.find((e) => e.name === 'MAX_RETRIES' && e.type === 'variable');
      expect(v).toBeDefined();
    });

    it('does NOT extract non-exported variable internalSecret', () => {
      const v = result.entities.find((e) => e.name === 'internalSecret');
      expect(v).toBeUndefined();
    });

    it('does NOT extract non-exported function privateHelper', () => {
      const v = result.entities.find((e) => e.name === 'privateHelper');
      expect(v).toBeUndefined();
    });

    it('extracts signature for arrow function variable', () => {
      const v = result.entities.find((e) => e.name === 'multiply' && e.type === 'variable');
      expect(v).toBeDefined();
      expect(v?.signature).toBeDefined();
      expect(v?.signature).toContain('number');
    });
  });

  describe('Stable IDs', () => {
    it('generates deterministic IDs across multiple parse calls', () => {
      const result2 = parseFile('src/example.ts', FIXTURE, 'my-repo');
      const ids1 = result.entities.map((e) => e.id).sort();
      const ids2 = result2.entities.map((e) => e.id).sort();
      expect(ids1).toEqual(ids2);
    });

    it('ID format is repo:filePath:type:name', () => {
      for (const entity of result.entities) {
        expect(entity.id).toBe(`${entity.repo}:${entity.filePath}:${entity.type}:${entity.name}`);
      }
    });
  });
});
