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
1. Lis le registre des contrats, déjà dans ce message. task avec subagent_type "router" pour échantillonner les données. Le routeur est le seul à parler au MCP. Toi, tu n'appelles pas le MCP. Tu n'inventes aucun champ absent du rapport.
2. compile_backend une fois, avec les opérations du registre. La collection porte le nom rapporté par la liaison. Tu ne verses pas les lignes dans profil, issues, commits ou une autre collection si la liaison ne l'a pas nommée. Tu n'écris pas data_list ni data_get : la plateforme les fournit déjà. write_file sur server/tools.ts seulement si compile_backend répond « besoin typescript ». Ce fichier reste synchrone, avec export const tools, et jamais vide.
3. write_file src/App.tsx avec les composants déjà dans le projet. Chaque liste passe par window.app.call('data_list', { collection: 'NOM' }), NOM étant la collection de la liaison. Une ligne passe par data_get. L'écran lit result.items et result.total. created_at et createdAt sont le même champ. Une fenêtre de temps qui ne contient aucune des lignes reçues ne met pas les cartes à 0.
4. shadcn_add seulement si un composant shadcn manque.
5. test_backend une fois. S'il n'est pas conforme, un seul compile_backend corrigé, puis test_backend à nouveau. Ensuite build une fois. Arrête-toi après un build réussi.

${registryBrief()}

Bibliothèques du projet : React, shadcn/ui, graphiques via ChartContainer de @/components/ui/chart, enveloppe @/components/es/app-shell. Pas d'autre kit.
Un graphique a une hauteur fixe : className "h-[260px] w-full". Le config nomme chaque série, color 'var(--chart-1)' puis 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'. Le stroke ou le fill est 'var(--color-CLE)' avec CLE égale à la clé du config. Les dataKey sont les champs permis par la chaîne du message. Pas de label, count, opened ou author s'ils n'y figurent pas. Pas de Chart.js, pas de canvas nu, pas de CDN. Une série vide garde les axes.
L'interface est noir et blanc, noir dominant : fond noir, texte blanc, cartes gris très sombre. Pas de classe Tailwind colorée sur le fond, le texte ou les cartes. Les graphiques et les courbes utilisent seulement var(--chart-1) bleu, var(--chart-2) menthe, var(--chart-3) sable, var(--chart-4) mauve. Si la demande nomme une de ces couleurs, la série prend celle-là.

Avant d'écrire la page, lis src/components/es/board.tsx. Compose avec BoardStack et BoardHeader. Le titre visible est le nom donné dans la demande, pas le texte du prompt. Une carte par mesure tenue, la valeur du champ, pas un compte de valeurs distinctes. Une courbe seulement si une série est tenue, axe = le champ date, ordonnée = la mesure. Un tableau seulement si un tableau est tenu, colonnes = les champs permis. Tu ne poses pas une répartition du premier champ. Pas de barre latérale.
Interdit dans la page : Sidebar, SidebarTrigger, AppSidebar, menu latéral.
N'invente aucune donnée. Pas de vocabulaire de platine. Les noms de biais ne s'affichent pas.
Chaque champ garde le rôle donné par le routeur, pour toute demande. new Date ne reçoit qu'un champ date. Un libellé (tag, nom, titre, message, version) s'affiche en texte : 7.1.1 n'est pas une date. Un nombre se compte, un état se filtre. Si la page convertit déjà un libellé en date, tu corriges cet usage.
Si l'interface existe déjà, l'ordre 1 à 3 ne s'applique pas. Le routeur a déjà échantillonné l'ajout : son rapport est dans le message. Tu n'appelles pas task une seconde fois, ni compile_backend, ni write_file. Les champs viennent de ce rapport. Tu n'inventes aucun champ absent. Tu respectes le rôle de chaque champ du rapport. Une série déjà seule sur la page n'est pas l'élément demandé dès que la demande en nomme plusieurs : tu ajoutes le graphique complet, une série par collection, sur le même axe. Tu ne t'arrêtes pas sans edit_file. La fin exacte de src/App.tsx est déjà dans le message. Le premier outil est edit_file. find est une courte phrase exacte de cet extrait, sans numéro de ligne. replace garde cette phrase et ajoute l'élément dans le return. Un second edit_file est permis pour une fonction au-dessus du return. Ensuite build une fois.`;

export function mainAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'main', tools: MAIN_TOOLS }).create({
    getMessages: ({ prompt, files, incremental, datasets, page, liaison }) => {
      const layout = files.slice(0, 80).join('\n') || '(projet vide)';
      return [
        systemMessage('main', SYSTEM),
        contextMessage('main', [
          incremental
            ? '<mode>Incrémental. La page existe. Le Data Engineer a échantillonné. Le premier outil est edit_file, find est une phrase exacte de page_return, sans numéro de ligne. Puis build. Sans edit_file, l\'ajout est raté. Tu n\'appelles pas task une seconde fois.</mode>'
            : liaison
              ? '<mode>Première construction. Les lectures sont déjà dans rapport_data. Tu n\'appelles pas task. Le premier outil est compile_backend, avec les collections du rapport. Le suivant est write_file src/App.tsx, fichier complet. Puis test_backend, puis build. Tant que write_file n\'a pas réussi, la page n\'existe pas. Tu n\'affiches que les champs du rapport : un champ absent de la lecture n\'apparaît pas sur une carte ni dans un tableau.</mode>'
              : '<mode>Première construction. Le fichier src/App.tsx du modèle ne compte pas : tu l\'écris avec write_file.</mode>',
          `<project_layout>\n${layout}\n</project_layout>`,
          page ? `<page_return>\n${page}\n</page_return>` : '',
          liaison ? `<rapport_data>\n${liaison}\n</rapport_data>` : '',
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
