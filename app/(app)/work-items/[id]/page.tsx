import { WorkItemDetail } from "./work-item-detail";

export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkItemDetail id={id} />;
}
