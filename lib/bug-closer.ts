/**
 * Bug Closer: Marks Notion bugs as "Fixed" when their associated work item PR merges.
 */

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

/**
 * Finds a bug in the Notion Bugs database by work item ID and marks it Fixed.
 * No-ops silently if no matching bug is found.
 */
export async function findAndCloseBug(
  workItemId: string,
  prUrl: string,
): Promise<void> {
  const token = process.env.NOTION_API_KEY;
  if (!token) return;

  // Query for the bug page matching this work item ID
  const queryRes = await fetch(
    `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Work Item ID",
          rich_text: { equals: workItemId },
        },
        page_size: 1,
      }),
    },
  );

  if (!queryRes.ok) {
    throw new Error(
      `Notion bugs query failed: ${queryRes.status} ${await queryRes.text()}`,
    );
  }

  const data = await queryRes.json();
  if (!data.results || data.results.length === 0) return;

  const bugPageId = data.results[0].id;

  // Update the bug: mark Fixed and link the PR
  const updateRes = await fetch(
    `https://api.notion.com/v1/pages/${bugPageId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          Status: {
            status: { name: "Fixed" },
          },
          "Fix PR URL": {
            url: prUrl,
          },
        },
      }),
    },
  );

  if (!updateRes.ok) {
    throw new Error(
      `Failed to close bug ${bugPageId}: ${updateRes.status} ${await updateRes.text()}`,
    );
  }
}
