import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeApi, RuntimeGroupList } from "@/shared/api/runtime-client";
import { RuntimeInvalidationProvider } from "@/shared/server-state/runtime-invalidation";
import { useGroupsScopeController } from "./useGroupsScopeController";

const sessionId = "primary-session";

const savedList: RuntimeGroupList = {
  archivedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  description: null,
  groupCount: 0,
  id: "11111111-1111-4111-8111-111111111111",
  membershipRevision: 1,
  name: "Priority groups",
  revision: 1,
  sessionId,
  updatedAt: "2026-08-15T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <RuntimeInvalidationProvider>{children}</RuntimeInvalidationProvider>;
}

describe("useGroupsScopeController", () => {
  it("ignores a catalog response after its search is superseded", async () => {
    const pendingCatalog = deferred<{
      data: RuntimeGroupList[];
      meta: { limit: number; offset: number; total: number };
    }>();
    const listGroupLists = vi.fn().mockReturnValue(pendingCatalog.promise);
    const api = { listGroupLists } as unknown as RuntimeApi;
    const { result, unmount } = renderHook(
      () => useGroupsScopeController({ api, sessionId }),
      { wrapper },
    );

    await waitFor(() => expect(listGroupLists).toHaveBeenCalledTimes(1));
    act(() => result.current.setCatalogInputQuery("priority"));
    await act(async () => {
      pendingCatalog.resolve({
        data: [savedList],
        meta: { limit: 50, offset: 0, total: 1 },
      });
      await pendingCatalog.promise;
    });

    expect(result.current.catalogLists).toEqual([]);
    unmount();
  });

  it("admits only one save pipeline and invalidates it on unmount", async () => {
    const pendingCreate = deferred<RuntimeGroupList>();
    const createGroupList = vi.fn().mockReturnValue(pendingCreate.promise);
    const getGroupListMembership = vi.fn();
    const api = {
      createGroupList,
      getGroupListMembership,
      listGroupLists: vi.fn().mockResolvedValue({
        data: [],
        meta: { limit: 50, offset: 0, total: 0 },
      }),
    } as unknown as RuntimeApi;
    const { result, unmount } = renderHook(
      () => useGroupsScopeController({ api, sessionId }),
      { wrapper },
    );

    act(() => result.current.requestCreate("scope"));
    act(() => result.current.updateMetadata({
      description: "",
      name: savedList.name,
    }));

    let firstSave!: Promise<RuntimeGroupList | null>;
    let secondSave!: Promise<RuntimeGroupList | null>;
    act(() => {
      firstSave = result.current.saveMetadata();
      secondSave = result.current.saveMetadata();
    });

    await expect(secondSave).resolves.toBeNull();
    expect(createGroupList).toHaveBeenCalledTimes(1);

    unmount();
    pendingCreate.resolve(savedList);

    await expect(firstSave).resolves.toBeNull();
    expect(getGroupListMembership).not.toHaveBeenCalled();
  });
});
