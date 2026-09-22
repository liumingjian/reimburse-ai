import { Button } from '@carbon/react';
import { CheckmarkFilled, Download, Extensions, SettingsAdjust } from '@carbon/icons-react';
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_VERSION } from '@baox/contract';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { SETTINGS_HASH } from '../router';

// The longer onboarding guide lives on its own route so the routine settings view can answer one question quickly:
// what state is this account's extension in, and what should the employee do next?
export const EXTENSION_INSTALL_COPY = {
  download: '下载浏览器扩展',
  offeredVersion: (version: string) => `这里提供的扩展版本：${version}`,
  outdated: (installed: string, offered: string) => `你装的扩展是 ${installed} 版，这里提供的是 ${offered} 版。请按下面“升级扩展”的步骤换成新版本。`,
  installTitle: '安装扩展',
  installLead: '扩展只能装在 Chrome 或 Edge 里。它不经过应用商店，而是由你把下载的安装包解压，再交给浏览器加载。照下面的步骤一步步做就行。',
  installSteps: [
    '点击上面的“下载浏览器扩展”，浏览器会下载一个名为 baox-extension.zip 的压缩包。',
    '在“文档”这类不会随手清理的地方新建一个文件夹，例如“报销助手扩展”，把压缩包里的全部文件解压到这个文件夹里。打开它，应该能直接看到 manifest.json 等几个文件。以后不要删除或移动这个文件夹，浏览器每次启动都要从这里读取扩展。',
    '打开浏览器的扩展管理页：Chrome 在地址栏输入 chrome://extensions 后按回车；Edge 输入 edge://extensions 后按回车。',
    '打开开发者模式：Chrome 的开关在页面右上角，叫“开发者模式”；Edge 的开关在页面左侧，叫“开发人员模式”（窗口较窄时先点左上角的菜单按钮才能看到）。开发者模式只是允许加载不来自应用商店的扩展，不会改动浏览器的其他设置。',
    '点击页面上出现的“加载已解压的扩展程序”（Edge 里叫“加载解压缩的扩展”），选中第 2 步的那个文件夹，再点“选择文件夹”。',
    '页面上出现“报销助手”，就装好了。点击浏览器右上角拼图形状的扩展按钮，把“报销助手”固定到工具栏，以后更容易找到。',
    '点击工具栏上的“报销助手”，填入下方生成的配对码。',
  ],
  startupNote: '以后浏览器启动时，可能会提示关闭开发者模式下的扩展。直接关掉这条提示即可，不要选择停用扩展，否则去报销时扩展不在。',
  upgradeTitle: '升级扩展',
  upgradeLead: '扩展不会自动更新。应用升级之后，扩展可能提示版本太旧、连不上，这时按下面的步骤换成新版本。',
  upgradeSteps: [
    '点击上面的“下载浏览器扩展”，下载新的压缩包。',
    '打开安装时建的那个文件夹，删掉里面原有的全部文件，再把新压缩包里的全部文件解压进去。请用原来的文件夹，换一个新文件夹会让浏览器里出现两个扩展。',
    '打开扩展管理页（Chrome 是 chrome://extensions，Edge 是 edge://extensions），在“报销助手”上点击刷新形状的“重新加载”按钮。',
    '看一眼“报销助手”上显示的版本号，和这里提供的版本一致就升级好了。如果扩展提示需要重新配对，就在下方重新生成配对码。',
  ],
  bannerTitle: '去报销时浏览器顶部的提示条',
  bannerBody: '去报销时，扩展会新开一个报销系统的标签页，在那里替你填写。这时浏览器顶部会出现一条提示，写着“报销助手”已开始调试此浏览器，或者正在调试此浏览器。这是正常的：扩展正是靠它把内容填进报销系统，提示条会一直显示到这次填写结束。',
  bannerCancel: '不要点这条提示上的“取消”。点了它，扩展会暂时失去对那个标签页的控制：如果当时它没有正在往报销系统里写，它会重新接管同一个标签页，确认页面没变之后接着做下去；如果正写到一半，这一步有没有生效看不出来，这次去报销就停下，转去对账。请回到应用，按页面上的提示处理。',
} as const;

export const EXTENSION_TUTORIAL_COPY = {
  title: '浏览器扩展安装教程',
  lead: '跟着下面的图示把扩展装好，再回到设置页生成配对码。教程会在单独的浏览器标签页打开，设置页里的状态不会丢。',
  back: '返回设置',
  download: EXTENSION_INSTALL_COPY.download,
  install: EXTENSION_INSTALL_COPY.installTitle,
  installLead: EXTENSION_INSTALL_COPY.installLead,
  upgrade: EXTENSION_INSTALL_COPY.upgradeTitle,
  upgradeLead: EXTENSION_INSTALL_COPY.upgradeLead,
  startup: EXTENSION_INSTALL_COPY.startupNote,
  banner: EXTENSION_INSTALL_COPY.bannerTitle,
  bannerBody: EXTENSION_INSTALL_COPY.bannerBody,
  bannerCancel: EXTENSION_INSTALL_COPY.bannerCancel,
  stepsTitle: '安装步骤',
  stepOne: {
    title: '下载并解压',
    label: '下载',
    illustration: '下载扩展压缩包',
    body: `${EXTENSION_INSTALL_COPY.installSteps[0]} ${EXTENSION_INSTALL_COPY.installSteps[1]}`,
  },
  stepTwo: {
    title: '打开扩展管理页',
    label: '设置',
    illustration: '打开 Chrome 或 Edge 的扩展管理页',
    body: `${EXTENSION_INSTALL_COPY.installSteps[2]} ${EXTENSION_INSTALL_COPY.installSteps[3]}`,
  },
  stepThree: {
    title: '加载报销助手',
    label: '加载',
    illustration: '加载已解压的报销助手扩展',
    body: `${EXTENSION_INSTALL_COPY.installSteps[4]} ${EXTENSION_INSTALL_COPY.installSteps[5]}`,
  },
  stepFour: {
    title: '输入配对码',
    label: '完成',
    illustration: '在报销助手中输入配对码',
    body: EXTENSION_INSTALL_COPY.installSteps[6],
  },
} as const;

const TUTORIAL_STEPS = [
  EXTENSION_TUTORIAL_COPY.stepOne,
  EXTENSION_TUTORIAL_COPY.stepTwo,
  EXTENSION_TUTORIAL_COPY.stepThree,
  EXTENSION_TUTORIAL_COPY.stepFour,
] as const;

const STEP_ICONS = [Download, SettingsAdjust, Extensions, CheckmarkFilled] as const;

function BrowserIllustration() {
  return (
    <div className="app-tutorial-hero-art" role="img" aria-label="浏览器扩展安装示意图">
      <div className="app-tutorial-browser">
        <div className="app-tutorial-browser-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <div className="app-tutorial-address">chrome://extensions</div>
        </div>
        <div className="app-tutorial-browser-body">
          <div className="app-tutorial-browser-sidebar" aria-hidden="true">
            <div />
            <div />
            <div />
          </div>
          <div className="app-tutorial-extension-card">
            <div className="app-tutorial-extension-mark" aria-hidden="true">
              <Extensions size={28} />
            </div>
            <div>
              <strong>报销助手</strong>
              <span>已加载 · 等待配对</span>
            </div>
            <CheckmarkFilled size={20} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TutorialStep({ index, step }: { index: number; step: (typeof TUTORIAL_STEPS)[number] }) {
  const Icon = STEP_ICONS[index] ?? Download;
  return (
    <li className="app-tutorial-step">
      <div className="app-tutorial-step-art" role="img" aria-label={step.illustration}>
        <Icon size={32} aria-hidden="true" />
        <span>{step.label}</span>
      </div>
      <div>
        <p className="app-tutorial-step-number">第 {index + 1} 步</p>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
      </div>
    </li>
  );
}

export function ExtensionTutorialPage() {
  return (
    <AppShell nav="settings">
      <div className="app-form-page app-tutorial-page">
        <PageHeader title={EXTENSION_TUTORIAL_COPY.title} lead={EXTENSION_TUTORIAL_COPY.lead} actions={<Button kind="ghost" href={SETTINGS_HASH}>{EXTENSION_TUTORIAL_COPY.back}</Button>} />
        <section className="app-form-section app-tutorial-intro" aria-label={EXTENSION_TUTORIAL_COPY.install}>
          <div>
            <p className="app-tutorial-kicker">Chrome / Edge</p>
            <h2 className="app-section-title">{EXTENSION_TUTORIAL_COPY.install}</h2>
            <p>{EXTENSION_TUTORIAL_COPY.installLead}</p>
          </div>
          <BrowserIllustration />
          <div className="app-btn-row">
            <Button kind="primary" href={EXTENSION_DOWNLOAD_PATH} renderIcon={Download}>
              {EXTENSION_TUTORIAL_COPY.download}
            </Button>
            <div className="app-tutorial-download-note">
              <p className="app-caption">{EXTENSION_INSTALL_COPY.offeredVersion(EXTENSION_VERSION)}</p>
              <p className="app-caption">下载后使用原来的文件夹，后续升级时也会用到。</p>
            </div>
          </div>
        </section>
        <section className="app-form-section" aria-label={EXTENSION_TUTORIAL_COPY.stepsTitle}>
          <h2 className="app-section-title">{EXTENSION_TUTORIAL_COPY.stepsTitle}</h2>
          <ol className="app-tutorial-steps" aria-label={EXTENSION_TUTORIAL_COPY.stepsTitle}>
            {TUTORIAL_STEPS.map((step, index) => <TutorialStep key={step.title} index={index} step={step} />)}
          </ol>
          <p className="app-caption">{EXTENSION_TUTORIAL_COPY.startup}</p>
        </section>
        <section className="app-form-section" aria-label={EXTENSION_TUTORIAL_COPY.upgrade}>
          <h2 className="app-section-title">{EXTENSION_TUTORIAL_COPY.upgrade}</h2>
          <p>{EXTENSION_TUTORIAL_COPY.upgradeLead}</p>
          <ol className="app-guide-steps" aria-label={EXTENSION_TUTORIAL_COPY.upgrade}>
            {EXTENSION_INSTALL_COPY.upgradeSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>
        <section className="app-form-section" aria-label={EXTENSION_TUTORIAL_COPY.banner}>
          <h2 className="app-section-title">{EXTENSION_TUTORIAL_COPY.banner}</h2>
          <p>{EXTENSION_TUTORIAL_COPY.bannerBody}</p>
          <p>{EXTENSION_TUTORIAL_COPY.bannerCancel}</p>
        </section>
      </div>
    </AppShell>
  );
}
