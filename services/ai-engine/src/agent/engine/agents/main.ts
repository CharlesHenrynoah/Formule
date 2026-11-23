import type { AgentEvent } from '../../events.ts';
import { registryBrief } from '../backend/registry.ts';
import { TOOLS } from '../tools/all.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const MAIN_TOOLS = [
  TOOLS.read_file, TOOLS.write_file, TOOLS.edit_file, TOOLS.grep, TOOLS.glob,
  TOOLS.shadcn_add, TOOLS.compile_backend, TOOLS.test_backend, TOOLS.build, TOOLS.task,
];

const SYSTEM = `Tu es l'agent principal. Tu construis l'interface dans le dossier du projet en appelant des outils, un seul à la fois. Quand tu cesses d'appeler des outils, la tâche s'arrête.

N'écris jamais le code dans le message. Le code passe par write_file ou edit_file.

Ordre :
1. Lis le registre des contrats, déjà dans ce message. task avec subagent_type "liaison" pour échantillonner les données. Toi, tu n'appelles pas le MCP. Tu n'inventes aucun champ absent du rapport.
2. compile_backend une fois, avec les opérations du registre. Les collections s'appellent issues, pullRequests, commits, depots ou profil : le nom rapporté par la liaison. Tu n'écris pas data_list ni data_get : la plateforme les fournit déjà. write_file sur server/tools.ts seulement si compile_backend répond « besoin typescript ». Ce fichier reste synchrone, avec export const tools, et jamais vide.
3. write_file src/App.tsx avec les composants déjà dans le projet. Chaque liste passe par window.app.call('data_list', { collection: 'NOM' }). Une ligne passe par data_get. Les totaux passent par les outils compilés. L'écran lit result.items et result.total. created_at et createdAt sont le même champ. Une fenêtre de temps qui ne contient aucune des lignes reçues ne met pas les cartes à 0.
4. shadcn_add seulement si un composant shadcn manque.
5. test_backend une fois. S'il n'est pas conforme, un seul compile_backend corrigé, puis test_backend à nouveau. Ensuite build une fois. Arrête-toi après un build réussi.

${registryBrief()}

Bibliothèques du projet : React, shadcn/ui, graphiques via ChartContainer de @/components/ui/chart, enveloppe @/components/es/app-shell. Pas d'autre kit.

Avant d'écrire la page, lis src/components/es/board.tsx et compose avec ces pièces : BoardStack, BoardHeader, MetricGrid (quatre MetricCard), BoardSplit (graphique en 4/7, liste en 3/7). C'est la composition de shadcn-admin, sans sa barre latérale.
Interdit dans la page : Sidebar, SidebarTrigger, AppSidebar, menu latéral.
N'invente aucune donnée. Pas de vocabulaire de platine. Les noms de biais ne s'affichent pas.
Si l'interface existe déjà, tu ajoutes ou retires des composants. Tu ne réécris pas tout.`;

export function mainAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'main', tools: MAIN_TOOLS }).create({
    getMessages: ({ prompt, files, incremental, datasets }) => {
      const layout = files.slice(0, 80).join('\n') || '(projet vide)';
      return [
        systemMessage('main', SYSTEM),
        contextMessage('main', [
          incremental ? '<mode>Incrémental : ajoute ou retire des composants du tableau. Ne réécris pas l\'interface.</mode>' : '<mode>Première construction.</mode>',
          `<project_layout>\n${layout}\n</project_layout>`,
          datasets ? `<datasets>\n${datasets}\n</datasets>` : '',
          `<demande>\n${prompt}\n</demande>`,
        ].filter(Boolean).join('\n\n')),
      ];
    },
    onStart: async () => { emit({ type: 'agent', kind: 'role', role: 'dev', label: 'Développeur' }); },
    onFinish: async () => {},
    shouldContinue: shouldContinueWithToolCalls,
  });
}
