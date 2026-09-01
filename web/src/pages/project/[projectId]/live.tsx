import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { LiveView } from "@/src/features/live-view/components/LiveView";

export default function Live() {
  const router = useRouter();
  const { projectId } = router.query as { projectId: string };

  return (
    <Page
      headerProps={{
        title: "Live",
        help: {
          description:
            "Observations stream in near real time on a sliding time axis, grouped per trace.",
        },
      }}
    >
      <LiveView projectId={projectId} />
    </Page>
  );
}
