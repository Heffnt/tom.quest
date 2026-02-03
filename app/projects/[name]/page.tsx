import { notFound } from "next/navigation";
import ProjectViewer from "../ProjectViewer";

const PROJECTS = {
  "boolback-results": {
    title: "BoolBack Results",
    filePath: "/home/ntheffernan/booleanbackdoors/ComplexMultiTrigger/output/undefended_results.html",
  },
} as const;

type ProjectKey = keyof typeof PROJECTS;

export default function ProjectPage({ params }: { params: { name: string } }) {
  const project = PROJECTS[params.name as ProjectKey];
  if (!project) {
    notFound();
  }
  return <ProjectViewer title={project.title} filePath={project.filePath} />;
}
