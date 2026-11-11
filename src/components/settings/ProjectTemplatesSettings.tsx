import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Atom, Bot, CircleAlert, File, Folder, FolderPlus, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { chooseTemplateFolder, projectStart, startFailure, type ProjectTemplate } from "@/lib/projectStart";
import { RegisteredSetting } from "./settingsRegistry";

const ICONS: Record<string, LucideIcon> = { empty: File, "vite-react": Atom, "agent-starter": Bot };

/**
 * Settings › Projects: the templates "Create a project" offers. The built-in
 * ones are listed for reference; the reader's own are folders on this
 * computer, added here and read each time a project is made from them.
 */
export function ProjectTemplatesSettings() {
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      setTemplates(await projectStart.templates());
    } catch (cause) {
      setError(startFailure(cause).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setError(null);
    setNotice("");
    const folder = await chooseTemplateFolder().catch(() => null);
    if (!folder) return;
    setBusy("add");
    try {
      const added = await projectStart.addTemplate(folder);
      await load();
      setNotice(`${added.name} is now a template in Create a project.`);
    } catch (cause) {
      setError(startFailure(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (template: ProjectTemplate) => {
    setError(null);
    setNotice("");
    setBusy(template.id);
    try {
      await projectStart.removeTemplate(template.id);
      await load();
      setNotice(`${template.name} was removed from the templates. Its folder was not changed.`);
    } catch (cause) {
      setError(startFailure(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const builtIn = templates?.filter((template) => template.builtIn) ?? [];
  const own = templates?.filter((template) => !template.builtIn) ?? [];

  return (
    <RegisteredSetting setting="projects.templates">
      <section aria-labelledby="project-templates-title" className="space-y-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h3 id="project-templates-title" className="text-[13px] font-medium">Project templates</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Create a project starts a new project from one of these: it copies the template's files into the new folder and commits them as the first commit on main. A folder you add is read each time, so changing it changes what the next project gets. In a Git repository, only the files Git would commit are copied.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void add()}>
            {busy === "add" ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            Add a template from a folder…
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}

        {templates === null && !error ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading templates…
          </p>
        ) : (
          <>
            <div>
              <h4 className="mb-1.5 text-xs text-faint">Your templates</h4>
              {own.length ? (
                <ul aria-label="Your templates" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
                  {own.map((template) => (
                    <li key={template.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                      {template.problem ? <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden /> : <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{template.name}</div>
                        <div className={template.problem ? "text-xs text-warning" : "truncate font-mono text-xs text-faint"} title={template.path}>
                          {template.problem ?? template.path}
                        </div>
                      </div>
                      <Button size="xs" variant="ghost" aria-label={`Remove ${template.name}`} disabled={busy !== null} onClick={() => void remove(template)}>
                        {busy === template.id ? <Loader2 className="animate-spin" /> : null}
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg bg-well px-3 py-3 text-xs text-faint">None yet. Add a folder to start new projects with its files.</p>
              )}
            </div>

            <div>
              <h4 className="mb-1.5 text-xs text-faint">Built in</h4>
              <ul aria-label="Built-in templates" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
                {builtIn.map((template) => {
                  const Icon = ICONS[template.id] ?? File;
                  return (
                    <li key={template.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{template.name}</div>
                        <div className="truncate text-xs text-faint">{template.description}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </section>
    </RegisteredSetting>
  );
}
