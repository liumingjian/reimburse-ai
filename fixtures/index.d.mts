/** Absolute path of `generated/`: sample originals, print page images and the merged print sheet. */
export declare const GENERATED_DIR: string;

/** Absolute path of `sample-materials.json`. */
export declare const SAMPLE_MATERIALS_FILE: string;

/** One sample original: its generated file name and the business file name it is uploaded under. */
export type SampleMaterial = { file: string; fileName: string };

/** The manifest, the single source of sample file names; the mock's recognition profiles must agree with it (see web/src/mock/new-task.test.ts). */
export declare const SAMPLE_MATERIALS: readonly SampleMaterial[];

/** Generated materials that exist only for tests, outside the mock's demo set; same shape as the manifest. */
export declare const REGRESSION_MATERIALS: readonly SampleMaterial[];

/**
 * Absolute path of `legacy-baox/`: a synthetic legacy `~/.baox` (schemaVersion 1) for the one-time import. Alice
 * (tenant-a) is the bound identity; tasks a1 (`saved`), b1 (`upload_dispatched`), d1 (`erp-fill`, no invoices) touched
 * ERP; c1 never did. Tests must not write into it: copy it first.
 */
export declare const LEGACY_BAOX_DIR: string;
