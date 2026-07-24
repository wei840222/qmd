import type {
  BenchmarkFixture,
  BenchmarkQuery,
  ResolvedBenchmarkQuery,
} from "./types.js";

function assertUniqueValues(
  values: string[],
  label: string,
  queryId?: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const scope = queryId ? ` query '${queryId}'` : "";
    if (value.trim().length === 0) {
      throw new Error(`Invalid fixture${scope}: empty ${label}`);
    }
    if (seen.has(value)) {
      throw new Error(`Invalid fixture${scope}: duplicate ${label} '${value}'`);
    }
    seen.add(value);
  }
}

function buildDocumentMap(fixture: BenchmarkFixture): Map<string, string> {
  const documents = new Map<string, string>();
  const files = new Set<string>();
  for (const document of fixture.documents ?? []) {
    if (document.id.trim().length === 0) {
      throw new Error("Invalid fixture: empty document id");
    }
    if (document.file.trim().length === 0) {
      throw new Error(`Invalid fixture: empty file for document id '${document.id}'`);
    }
    if (documents.has(document.id)) {
      throw new Error(`Invalid fixture: duplicate document id '${document.id}'`);
    }
    if (files.has(document.file)) {
      throw new Error(`Invalid fixture: duplicate document file '${document.file}'`);
    }
    documents.set(document.id, document.file);
    files.add(document.file);
  }
  return documents;
}

function resolveDocumentIds(
  documentIds: string[],
  documents: Map<string, string>,
  queryId: string,
): string[] {
  return documentIds.map((documentId) => {
    const file = documents.get(documentId);
    if (!file) {
      throw new Error(`Invalid fixture query '${queryId}': unknown document id '${documentId}'`);
    }
    return file;
  });
}

function resolveQuery(
  query: BenchmarkQuery,
  documents: Map<string, string>,
): ResolvedBenchmarkQuery {
  if (query.expected_files && query.relevant_doc_ids) {
    throw new Error(
      `Invalid fixture query '${query.id}': use expected_files or relevant_doc_ids, not both`,
    );
  }

  const relevantIds = query.relevant_doc_ids ?? [];
  const mustNotMatchIds = query.must_not_match_doc_ids ?? [];
  assertUniqueValues(relevantIds, "relevant document id", query.id);
  assertUniqueValues(mustNotMatchIds, "must-not-match document id", query.id);
  if (query.expected_files) assertUniqueValues(query.expected_files, "expected file", query.id);
  for (const documentId of relevantIds) {
    if (mustNotMatchIds.includes(documentId)) {
      throw new Error(
        `Invalid fixture query '${query.id}': document id '${documentId}' cannot be both relevant and must-not-match`,
      );
    }
  }

  const expectedFiles = query.expected_files
    ? [...query.expected_files]
    : resolveDocumentIds(relevantIds, documents, query.id);
  if (expectedFiles.length === 0) {
    throw new Error(`Invalid fixture query '${query.id}': no relevant documents`);
  }

  return {
    ...query,
    expected_files: expectedFiles,
    must_not_match_files: resolveDocumentIds(mustNotMatchIds, documents, query.id),
  };
}

export function resolveFixtureQueries(fixture: BenchmarkFixture): ResolvedBenchmarkQuery[] {
  const documents = buildDocumentMap(fixture);
  const queryIds = new Set<string>();

  return fixture.queries.map((query) => {
    if (query.id.trim().length === 0) {
      throw new Error("Invalid fixture: empty query id");
    }
    if (queryIds.has(query.id)) {
      throw new Error(`Invalid fixture: duplicate query id '${query.id}'`);
    }
    queryIds.add(query.id);
    return resolveQuery(query, documents);
  });
}