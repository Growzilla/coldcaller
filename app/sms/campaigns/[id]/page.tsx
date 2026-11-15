"use client";

import { useParams } from "next/navigation";
import { CampaignDetail } from "../../ui";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <CampaignDetail id={params.id} />;
}
