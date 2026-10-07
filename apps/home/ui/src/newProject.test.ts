import { describe, expect, it } from "vitest";
import {
  buildCreateRequest,
  deriveSlug,
  derivePlaneId,
  emptyForm,
  formIsValid,
  isServiceWired,
  isStepWired,
  STEP_IDS,
  stepPreviewDetail,
  stepTitle,
  unwiredValidators,
  validateForm,
  validateName,
  validateOwnerRepo,
  validatePath,
  validatePlaneId,
  validateRepoUrl,
  validateSlug,
} from "./newProject";

describe("deriveSlug", () => {
  it("matches board 14's own example", () => {
    expect(deriveSlug("Torn Apart")).toBe("torn-apart");
  });

  it("collapses runs of anything that is not a letter or digit into one dash", () => {
    expect(deriveSlug("Anomaly: Chapter Two!!")).toBe("anomaly-chapter-two");
  });

  it("has no leading or trailing dash", () => {
    expect(deriveSlug("  --Sandbox--  ")).toBe("sandbox");
  });

  it("caps at 40 characters", () => {
    const long = "A".repeat(60);
    expect(deriveSlug(long).length).toBe(40);
  });

  it("is idempotent against its own output", () => {
    const once = deriveSlug("Torn Apart");
    expect(deriveSlug(once)).toBe(once);
  });
});

describe("derivePlaneId", () => {
  it("matches board 14's own example", () => {
    expect(derivePlaneId("Torn Apart")).toBe("TORN");
  });

  it("caps the first word at 5 letters", () => {
    expect(derivePlaneId("Anomaly Detector")).toBe("ANOMA");
  });

  it("borrows from the next word when the first is under 3 letters", () => {
    expect(derivePlaneId("Go Fish")).toBe("GOFIS".slice(0, 5));
  });

  it("pads with X when there are no letters to borrow from at all", () => {
    expect(derivePlaneId("42")).toBe("XXX");
  });

  it("ignores punctuation and digits when picking letters", () => {
    expect(derivePlaneId("re:Load 2")).toBe("RELOA");
  });

  it("is empty only for an empty name", () => {
    expect(derivePlaneId("")).toBe("XXX");
  });
});

describe("validateName", () => {
  it("requires a non-blank name", () => {
    expect(validateName("")).not.toBeNull();
    expect(validateName("   ")).not.toBeNull();
    expect(validateName("Torn Apart")).toBeNull();
  });
});

describe("validateSlug", () => {
  it("accepts the derived slug for board 14's example", () => {
    expect(validateSlug(deriveSlug("Torn Apart"))).toBeNull();
  });

  it("rejects uppercase, spaces and punctuation", () => {
    expect(validateSlug("Torn Apart")).not.toBeNull();
    expect(validateSlug("torn_apart")).not.toBeNull();
  });

  it("rejects under 2 characters and over 40", () => {
    expect(validateSlug("a")).not.toBeNull();
    expect(validateSlug("a".repeat(41))).not.toBeNull();
  });

  it("accepts the 2 and 40 character boundaries", () => {
    expect(validateSlug("ab")).toBeNull();
    expect(validateSlug("a".repeat(40))).toBeNull();
  });
});

describe("validatePlaneId", () => {
  it("accepts the derived id for board 14's example", () => {
    expect(validatePlaneId(derivePlaneId("Torn Apart"))).toBeNull();
  });

  it("rejects lowercase, digits and the wrong length", () => {
    expect(validatePlaneId("torn")).not.toBeNull();
    expect(validatePlaneId("TO1")).not.toBeNull();
    expect(validatePlaneId("TO")).not.toBeNull();
    expect(validatePlaneId("TOOLONG")).not.toBeNull();
  });

  it("accepts the 3 and 5 letter boundaries", () => {
    expect(validatePlaneId("ABC")).toBeNull();
    expect(validatePlaneId("ABCDE")).toBeNull();
  });
});

describe("validateOwnerRepo / validateRepoUrl / validatePath", () => {
  it("owner/repo needs exactly one slash with something on each side", () => {
    expect(validateOwnerRepo("Firelight-Innovations/torn-apart")).toBeNull();
    expect(validateOwnerRepo("torn-apart")).not.toBeNull();
    expect(validateOwnerRepo("/torn-apart")).not.toBeNull();
  });

  it("a repo URL and a path both just need to be non-blank", () => {
    expect(validateRepoUrl("")).not.toBeNull();
    expect(validateRepoUrl("https://github.com/x/y")).toBeNull();
    expect(validatePath("")).not.toBeNull();
    expect(validatePath("C:/code/torn-apart")).toBeNull();
  });
});

describe("validateForm", () => {
  it("only checks the code fields the current codeSource shows", () => {
    const form = { ...emptyForm(), name: "Torn Apart", slug: "torn-apart", planeId: "TORN" };

    const newGithub = validateForm({ ...form, codeSource: "newGithubRepo", ownerRepo: "a/b" });
    expect(newGithub.ownerRepo).toBeNull();
    // repoUrl and path are not shown for this source, so they are not checked.
    expect(newGithub.repoUrl).toBeNull();
    expect(newGithub.path).toBeNull();

    const existing = validateForm({
      ...form,
      codeSource: "existingRepo",
      repoUrl: "https://github.com/x/y",
      path: "C:/code/torn-apart",
    });
    expect(existing.repoUrl).toBeNull();
    expect(existing.path).toBeNull();
    // ownerRepo is not shown for this source.
    expect(existing.ownerRepo).toBeNull();
  });

  it("a fully valid form has no errors", () => {
    const form = {
      ...emptyForm(),
      name: "Torn Apart",
      slug: "torn-apart",
      planeId: "TORN",
      codeSource: "localFolder" as const,
      path: "C:/code/torn-apart",
    };
    expect(formIsValid(validateForm(form))).toBe(true);
  });

  it("a blank form is invalid", () => {
    expect(formIsValid(validateForm(emptyForm()))).toBe(false);
  });
});

describe("buildCreateRequest", () => {
  it("shapes a local-folder request the way apps::home_create parses it", () => {
    const form = {
      ...emptyForm(),
      kind: "tool" as const,
      codeSource: "localFolder" as const,
      path: "C:/code/torn-apart",
    };
    expect(buildCreateRequest(form)).toEqual({
      kind: "tool",
      code: { source: "localFolder", path: "C:/code/torn-apart" },
      initGit: true,
    });
  });

  it("asks to initialise git by default and carries a no", () => {
    const base = { ...emptyForm(), codeSource: "localFolder" as const, path: "C:/code/x" };
    expect(emptyForm().initGit).toBe(true);
    expect(buildCreateRequest(base).initGit).toBe(true);
    expect(buildCreateRequest({ ...base, initGit: false }).initGit).toBe(false);
  });

  it("never asks Open existing to initialise anything", () => {
    const form = {
      ...emptyForm(),
      kind: "openExisting" as const,
      codeSource: "localFolder" as const,
      path: "C:/code/x",
    };
    expect(buildCreateRequest(form)).not.toHaveProperty("initGit");
  });

  it("sends no initGit for a clone, which is already a repository", () => {
    const form = { ...emptyForm(), codeSource: "existingRepo" as const, repoUrl: "u", path: "p" };
    expect(buildCreateRequest(form)).not.toHaveProperty("initGit");
  });

  it("shapes an existing-repo request with both the url and the clone-to path", () => {
    const form = {
      ...emptyForm(),
      codeSource: "existingRepo" as const,
      repoUrl: "https://github.com/x/y.git",
      path: "C:/code/torn-apart",
    };
    expect(buildCreateRequest(form)).toEqual({
      kind: "game",
      code: {
        source: "existingRepo",
        url: "https://github.com/x/y.git",
        cloneTo: "C:/code/torn-apart",
      },
    });
  });

  it("a new-github-repo request carries no path — the server never reaches it", () => {
    const form = { ...emptyForm(), codeSource: "newGithubRepo" as const };
    expect(buildCreateRequest(form)).toEqual({ kind: "game", code: { source: "newGithubRepo" } });
  });
});

describe("emptyForm's service defaults", () => {
  it("defaults every not-wired service off, and the one wired one on", () => {
    const form = emptyForm();
    expect(form.services.plane).toBe(false);
    expect(form.services.registry).toBe(false);
    expect(form.services.hindsight).toBe(false);
    expect(form.services.costLabel).toBe(false);
    expect(form.services.designWorktree).toBe(true);
  });
});

describe("isServiceWired / isStepWired", () => {
  it("agree on which one thing this build actually does beyond landing the code", () => {
    expect(isServiceWired("designWorktree")).toBe(true);
    expect(isServiceWired("plane")).toBe(false);
    expect(isServiceWired("registry")).toBe(false);
    expect(isServiceWired("hindsight")).toBe(false);
    expect(isServiceWired("costLabel")).toBe(false);
  });

  it("wires exactly the three steps apps::home_create actually runs", () => {
    const wired = STEP_IDS.filter(isStepWired);
    expect(wired).toEqual(["cloneOrLink", "designWorktree", "openProject"]);
  });
});

describe("stepTitle / stepPreviewDetail", () => {
  it("has a title for every step id, in both kinds cloneOrLink's wording changes for", () => {
    for (const id of STEP_IDS) {
      expect(stepTitle(id, "game").length).toBeGreaterThan(0);
      expect(stepTitle(id, "openExisting").length).toBeGreaterThan(0);
    }
    expect(stepTitle("cloneOrLink", "openExisting")).not.toBe(stepTitle("cloneOrLink", "game"));
  });

  it("tells the truth: a not-wired step's preview says so, a wired one doesn't", () => {
    expect(stepPreviewDetail("plane")).toBe("Not wired yet in this build.");
    expect(stepPreviewDetail("cloneOrLink")).not.toBe("Not wired yet in this build.");
  });
});

describe("unwiredValidators", () => {
  it("honestly reports every check as not checked, never as available", async () => {
    const slug = await unwiredValidators.slugAvailable("torn-apart");
    const plane = await unwiredValidators.planeIdAvailable("TORN");
    const repo = await unwiredValidators.repoNameAvailable("Firelight-Innovations/torn-apart");

    for (const result of [slug, plane, repo]) {
      expect(result.status).toBe("unknown");
      expect(result.status).not.toBe("ok");
    }
  });
});
