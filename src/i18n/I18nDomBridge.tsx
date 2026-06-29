import { useEffect, useRef } from 'react';
import { translateMessage } from './catalog';
import type { Language } from './types';
import { useI18n } from './I18nProvider';

const textOriginals = new WeakMap<Text, string>();
const attrOriginals = new WeakMap<Element, Map<string, string>>();
const TRANSLATABLE_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'KBD', 'SAMP']);

function shouldSkipElement(element: Element | null): boolean {
  let current = element;
  while (current) {
    if (SKIP_TAGS.has(current.tagName)) return true;
    if (current.hasAttribute('data-i18n-ignore')) return true;
    if (current.getAttribute('contenteditable') === 'true') return true;
    current = current.parentElement;
  }
  return false;
}

function translateTextNode(node: Text, language: Language) {
  if (shouldSkipElement(node.parentElement)) return;
  const original = textOriginals.get(node) ?? node.nodeValue ?? '';
  if (!textOriginals.has(node)) {
    textOriginals.set(node, original);
  }
  const translated = translateMessage(original, language);
  if (node.nodeValue !== translated) {
    node.nodeValue = translated;
  }
}

function translateElementAttributes(element: Element, language: Language) {
  if (shouldSkipElement(element)) return;
  let originals = attrOriginals.get(element);
  if (!originals) {
    originals = new Map<string, string>();
    attrOriginals.set(element, originals);
  }

  for (const attr of TRANSLATABLE_ATTRIBUTES) {
    if (!element.hasAttribute(attr)) continue;
    if (!originals.has(attr)) {
      originals.set(attr, element.getAttribute(attr) || '');
    }
    const original = originals.get(attr) || '';
    const translated = translateMessage(original, language);
    if (element.getAttribute(attr) !== translated) {
      element.setAttribute(attr, translated);
    }
  }
}

function applyI18n(root: ParentNode, language: Language) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    translateTextNode(current as Text, language);
    current = walker.nextNode();
  }

  if (root instanceof Element) {
    translateElementAttributes(root, language);
  }

  const elements = root instanceof Element
    ? [root, ...Array.from(root.querySelectorAll('*'))]
    : Array.from((root as Document).querySelectorAll('*'));
  for (const element of elements) {
    translateElementAttributes(element, language);
  }
}

export function I18nDomBridge() {
  const { language } = useI18n();
  const observerRef = useRef<MutationObserver | null>(null);
  const applyingRef = useRef(false);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;

    const apply = () => {
      applyingRef.current = true;
      try {
        applyI18n(root, language);
      } finally {
        applyingRef.current = false;
      }
    };

    apply();
    const frame = window.requestAnimationFrame(apply);

    observerRef.current?.disconnect();
    observerRef.current = new MutationObserver((mutations) => {
      if (applyingRef.current) return;
      applyingRef.current = true;
      try {
        for (const mutation of mutations) {
          if (mutation.type === 'characterData' && mutation.target instanceof Text) {
            translateTextNode(mutation.target, language);
          }
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof Text) {
              translateTextNode(node, language);
            } else if (node instanceof Element) {
              applyI18n(node, language);
            }
          }
          if (mutation.type === 'attributes' && mutation.target instanceof Element) {
            translateElementAttributes(mutation.target, language);
          }
        }
      } finally {
        applyingRef.current = false;
      }
    });
    observerRef.current.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES, 'data-i18n-ignore'],
    });

    const handleRefresh = () => apply();
    window.addEventListener('bstg:i18n-change', handleRefresh);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('bstg:i18n-change', handleRefresh);
      observerRef.current?.disconnect();
    };
  }, [language]);

  return null;
}
