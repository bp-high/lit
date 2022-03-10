/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import '../elements/interpreter_controls';
import '@material/mwc-icon';

import {MobxLitElement} from '@adobe/lit-mobx';
import {css, html, TemplateResult} from 'lit';
// tslint:disable:no-new-decorators
import {customElement, property} from 'lit/decorators';
import {computed, observable} from 'mobx';

import {app} from '../core/app';
import {LitModule} from '../core/lit_module';
import {TableData, TableEntry} from '../elements/table';
import {styles as sharedStyles} from '../lib/shared_styles.css';
import {CallConfig, ComponentInfoMap, IndexedInput, ModelInfoMap, Spec} from '../lib/types';
import {findSpecKeys, isLitSubtype} from '../lib/utils';
import {AppState, SelectionService} from '../services/services';

import {styles} from './tda_module.css';

/**
 * Custom element for in-table add/remove controls.
 * We use a custom element here so we can encapsulate styles.
 */
@customElement('tda-output-row-controls')
export class OutputRowControls extends MobxLitElement {
  @property({type: Boolean, reflect: true}) exampleInDataset = false;

  static override get styles() {
    return [
      sharedStyles, styles, css`
            :host {
              display: flex;
              flex-direction: row;
              color: #1a73e8;
            }
            :host > * {
              margin-right: 4px;
            }
            `
    ];
  }

  override render() {
    const addPoint = () => {
      const event = new CustomEvent('add-point');
      this.dispatchEvent(event);
    };

    if (this.exampleInDataset) {
      // clang-format off
      return html`
        <mwc-icon class="icon-button outlined disabled">
          done
        </mwc-icon>
      `;
      // clang-format on
    }

    // clang-format off
    return html`
      <mwc-icon class="icon-button outlined" @click=${addPoint}>
        add_box
      </mwc-icon>
    `;
    // clang-format on
  }
}

/**
 * A LIT module that allows the user to generate new examples.
 */
@customElement('tda-module')
export class TrainingDataAttributionModule extends LitModule {
  static override title = 'Training Data Attribution';
  static override numCols = 10;

  static override duplicateForExampleComparison = true;
  static override duplicateForModelComparison = true;

  static override template = (model = '', selectionServiceIndex = 0) => {
    return html`<tda-module model=${model} selectionServiceIndex=${
        selectionServiceIndex}></tda-module>`;
  };

  static override get styles() {
    return [sharedStyles, styles];
  }

  @observable isRunning = false;

  @observable retrievedExamples: IndexedInput[][] = [];
  @observable appliedGenerator: string|null = null;

  @computed
  get datasetName() {
    return this.appState.currentDataset;
  }

  @computed
  get globalParams() {
    return {
      'model_name': this.model,
      'dataset_name': this.datasetName,
    };
  }

  static compatibleGenerators(generatorInfo: ComponentInfoMap): string[] {
    return Object.keys(generatorInfo).filter(name => {
      return findSpecKeys(generatorInfo[name].metaSpec, 'InfluentialExamples')
                 .length > 0;
    });
  }

  @computed
  get compatibleGenerators(): string[] {
    const generatorsInfo = this.appState.metadata.generators;
    return TrainingDataAttributionModule.compatibleGenerators(generatorsInfo);
  }

  @computed
  get totalNumGenerated() {
    return this.retrievedExamples.reduce((a, b) => a + b.length, 0);
  }

  override firstUpdated() {
    const getSelectedData = () =>
        this.selectionService.primarySelectedInputData;
    this.reactImmediately(getSelectedData, selectedData => {
      if (this.selectionService.lastUser !== this) {
        this.clearOutput();
      }
    });

    // If all staged examples are removed one-by-one, make sure we reset
    // to a clean state.
    this.react(() => this.totalNumGenerated, numAvailable => {
      if (numAvailable <= 0) {
        this.clearOutput();
      }
    });
  }

  private clearOutput() {
    this.retrievedExamples = [];
    this.appliedGenerator = null;
  }

  private handleGeneratorClick(generator: string, config?: CallConfig) {
    if (!this.isRunning) {
      this.clearOutput();
      this.retrieveExamples(generator, this.model, config);
    }
  }

  private async retrieveExamples(
      generator: string, modelName: string, config?: CallConfig) {
    this.isRunning = true;
    this.appliedGenerator = generator;
    const sourceExamples = this.selectionService.selectedInputData;
    try {
      const generated = await this.apiService.getGenerated(
          sourceExamples, modelName, this.appState.currentDataset, generator,
          config);
      // Populate additional metadata fields.
      // parentId and source should already be set from the backend.
      for (const examples of generated) {
        for (const ex of examples) {
          Object.assign(ex['meta'], {added: 1});
        }
      }
      this.retrievedExamples = generated;
      this.isRunning = false;
    } catch {
      this.isRunning = false;
    }
  }

  private async addToDataset(newExamples: IndexedInput[]) {
    this.appState.commitNewDatapoints(newExamples);
    const newIds = newExamples.map(d => d.id);
    if (newIds.length === 0) return;

    const parentIds =
        new Set<string>(newExamples.map(ex => ex.meta['parentId']!));

    // Select parents and children, and set primary to the first child.
    this.selectionService.selectIds([...parentIds, ...newIds], this);
    this.selectionService.setPrimarySelection(newIds[0], this);

    // If in comparison mode, set reference selection to the parent point
    // for direct comparison.
    if (this.appState.compareExamplesEnabled) {
      const referenceSelectionService =
          app.getServiceArray(SelectionService)[1];
      referenceSelectionService.selectIds([...parentIds, ...newIds], this);
      // parentIds[0] is not necessarily the parent of newIds[0], if
      // generated[0] is [].
      const parentId = newExamples[0].meta['parentId']!;
      referenceSelectionService.setPrimarySelection(parentId, this);
    }
  }

  renderFooterControls() {
    const controlsDisabled = this.totalNumGenerated <= 0;

    // clang-format off
    return html`
      <div class="footer-end-controls">
        <button class="hairline-button" ?disabled=${controlsDisabled}
           @click=${this.clearOutput}>
           Clear output
        </button>
      </div>`;
    // clang-format on
  }

  override render() {
    return html`
      <div class="module-container">
        <div class="module-content tda-module-content">
          ${this.renderControlSidebar()}
          ${this.renderRetrievedExamples()}
        </div>
        <div class="module-footer">
          <p class="module-status">${this.getStatus()}</p>
          ${this.renderFooterControls()}
        </div>
      </div>
    `;
  }

  /**
   * Determine module's status as a string to display in the footer.
   */
  getStatus(): string|TemplateResult {
    if (this.isRunning) {
      return 'Running...';
    }

    if (this.appliedGenerator) {
      const s = this.totalNumGenerated === 1 ? '' : 's';
      return `
        ${this.appliedGenerator}: retrieved ${this.totalNumGenerated}
        example${s}.
      `;
    }

    if (!this.compatibleGenerators.length) {
      return 'No generator components available.';
    }

    if (this.selectionService.primarySelectedInputData == null) {
      return 'Select an example to begin.';
    }

    return '';
  }

  renderInterstitial() {
    // clang-format off
    return html`
      <div class="interstitial">
        <img src="static/interstitial-select.png" />
        <p>
          <strong>Training Data Attribution</strong>
          Find training examples that are influential for a given prediction.
        </p>
      </div>`;
    // clang-format on
  }

  renderEmptyNotice() {
    // clang-format off
    return html`
      <div class="interstitial">
        <p>No examples generated.</p>
      </div>`;
    // clang-format on
  }

  renderRetrievedExamples() {
    const rows: TableData[] = this.createEntries();

    if (!this.appliedGenerator) {
      return this.renderInterstitial();
    }

    if (rows.length <= 0) {
      if (this.isRunning) {
        return null;
      } else {
        return this.renderEmptyNotice();
      }
    }

    // clang-format off
    return html`
      <div class="results-holder">
        <lit-data-table class="table"
            .columnNames=${Object.keys(rows[0])}
            .data=${rows}
        ></lit-data-table>
      </div>
    `;
    // clang-format on
  }

  /**
   * Render the generated counterfactuals themselves.
   */
  createEntries() {
    const rows: TableData[] = [];
    for (let parentIndex = 0; parentIndex < this.retrievedExamples.length;
         parentIndex++) {
      const generatedList = this.retrievedExamples[parentIndex];
      for (let generatedIndex = 0; generatedIndex < generatedList.length;
           generatedIndex++) {
        const example = generatedList[generatedIndex];
        const addPoint = async () => {
          await this.addToDataset([example]);
        };
        const row: {[key: string]: TableEntry} = {...example.data};
        const alreadyInDataset =
            this.appState.currentInputDataById.has(example.id);
        row['Add to Dataset'] = html`<tda-output-row-controls
                                      ?exampleInDataset=${alreadyInDataset}
                                      @add-point=${addPoint}/>`;
        rows.push(row);
      }
    }
    return rows;
  }

  renderControlSidebar() {
    const generatorsInfo = this.appState.metadata.generators;

    const onRunClick = (event: CustomEvent) => {
      // tslint:disable-next-line:no-any
      const generatorParams: {[setting: string]: string} =
          event.detail.settings;
      // tslint:disable-next-line:no-any
      const generatorName = event.detail.name;

      // Add user-specified parameters from the applied generator.
      const allParams = Object.assign({}, this.globalParams, generatorParams);
      this.handleGeneratorClick(generatorName, allParams);
    };

    // clang-format off
    return html`
        <div class="generators-panel">
          ${this.compatibleGenerators.map((genName, i) => {
            const spec = generatorsInfo[genName].configSpec;
            const clonedSpec = JSON.parse(JSON.stringify(spec)) as Spec;
            const description = generatorsInfo[genName].description;
            for (const fieldName of Object.keys(clonedSpec)) {
              // If the generator uses a field matcher, then get the matching
              // field names from the specified spec and use them as the vocab.
              if (isLitSubtype(clonedSpec[fieldName],
                               ['FieldMatcher','MultiFieldMatcher'])) {
                clonedSpec[fieldName].vocab =
                    this.appState.getSpecKeysFromFieldMatcher(
                        clonedSpec[fieldName], this.model);
              }
            }
            const runDisabled = this.selectionService.primarySelectedInputData == null;
            return html`
                <lit-interpreter-controls
                  .spec=${clonedSpec}
                  .name=${genName}
                  .description=${description||''}
                  .applyButtonText=${"Run"}
                  ?applyButtonDisabled=${runDisabled}
                  ?opened=${i === 0}
                  @interpreter-click=${onRunClick}>
                </lit-interpreter-controls>`;
          })}
        </div>
    `;
    // clang-format on
  }

  static override shouldDisplayModule(
      modelSpecs: ModelInfoMap, datasetSpec: Spec) {
    // TODO(b/204779018): Add appState generators to method arguments.

    // Ensure there are compatible generators.
    const appState = app.getService(AppState);
    if (appState.metadata == null) return false;

    return TrainingDataAttributionModule
               .compatibleGenerators(appState.metadata.generators)
               .length > 0;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tda-module': TrainingDataAttributionModule;
  }
}
