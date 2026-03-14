import { RepoForm } from "@/components/repo-form";

export default function NewRepoPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Add Repo</h1>
      <RepoForm />
    </div>
  );
}
