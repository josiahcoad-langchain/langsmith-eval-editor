/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATASET_NAME?: string;
  readonly VITE_REQUESTS_REPO?: string;
  readonly VITE_TRACE_PROJECT?: string;
  readonly VITE_PROPOSALS_QUEUE?: string;
}
