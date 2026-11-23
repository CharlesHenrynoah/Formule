// Table des modules importables par les mini-apps générées.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as Lucide from 'lucide-react';
import * as Sonner from 'sonner';
import * as utils from '@/lib/utils';
import * as accordion from '@/components/ui/accordion';
import * as alertDialog from '@/components/ui/alert-dialog';
import * as alert from '@/components/ui/alert';
import * as avatar from '@/components/ui/avatar';
import * as badge from '@/components/ui/badge';
import * as button from '@/components/ui/button';
import * as card from '@/components/ui/card';
import * as checkbox from '@/components/ui/checkbox';
import * as dialog from '@/components/ui/dialog';
import * as dropdownMenu from '@/components/ui/dropdown-menu';
import * as input from '@/components/ui/input';
import * as label from '@/components/ui/label';
import * as popover from '@/components/ui/popover';
import * as progress from '@/components/ui/progress';
import * as radioGroup from '@/components/ui/radio-group';
import * as scrollArea from '@/components/ui/scroll-area';
import * as select from '@/components/ui/select';
import * as separator from '@/components/ui/separator';
import * as sheet from '@/components/ui/sheet';
import * as skeleton from '@/components/ui/skeleton';
import * as slider from '@/components/ui/slider';
import * as sonnerUi from '@/components/ui/sonner';
import * as switchUi from '@/components/ui/switch';
import * as table from '@/components/ui/table';
import * as tabs from '@/components/ui/tabs';
import * as textarea from '@/components/ui/textarea';
import * as toggleGroup from '@/components/ui/toggle-group';
import * as toggle from '@/components/ui/toggle';
import * as tooltip from '@/components/ui/tooltip';

export const UI: Record<string, Record<string, unknown>> = {
  accordion, 'alert-dialog': alertDialog, alert, avatar, badge, button, card, checkbox, dialog,
  'dropdown-menu': dropdownMenu, input, label, popover, progress, 'radio-group': radioGroup,
  'scroll-area': scrollArea, select, separator, sheet, skeleton, slider, sonner: sonnerUi,
  switch: switchUi, table, tabs, textarea, 'toggle-group': toggleGroup, toggle, tooltip,
};

export const MODULES: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
  'lucide-react': Lucide,
  sonner: Sonner,
  '@/lib/utils': utils,
  ...Object.fromEntries(Object.entries(UI).map(([k, v]) => [`@/components/ui/${k}`, v])),
};

export { React, ReactDOMClient, Sonner };
