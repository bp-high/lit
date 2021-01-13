# Copyright 2020 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ==============================================================================
# Lint as: python3
"""Quantitative Testing with Concept Activation Vectors (TCAV)."""

import random
from typing import Any, List, Optional, cast, Text

import attr
from lit_nlp.api import components as lit_components
from lit_nlp.api import dataset as lit_dataset
from lit_nlp.api import model as lit_model
from lit_nlp.api import types
import numpy as np
import scipy.stats
import sklearn.linear_model
import sklearn.model_selection


JsonDict = types.JsonDict
Spec = types.Spec

NUM_SPLITS = 20  # TODO(lit-dev): Make this configurable in the UI.


@attr.s(auto_attribs=True, kw_only=True)
class TCAVConfig(object):
  """Config options for TCAV component."""
  concept_set_ids: List[str] = []
  class_to_explain: Any = ''
  grad_layer: Text = ''
  # Percentage of the example set to use in the test set when training the LM.
  test_size: Optional[float] = 0.33
  random_state: Optional[int] = 42


class TCAV(lit_components.Interpreter):
  """Quantitative Testing with Concept Activation Vectors (TCAV).

  TCAV is an interpretability method which allows users to define a concept
  by selecting a set of representative examples and trains a classifier at
  different model layers to determine whether that concept has any influence
  over the predictions of the model (https://arxiv.org/pdf/1711.11279.pdf).
  If so, it can be measured as an aggregate score, and also individual points
  can be measured by how much of that concept they contain, at a given layer.

  The original implementation can be found at:
  https://github.com/tensorflow/tcav

  This component requires that the following fields in the model spec. Field
  names like `layer` are placeholders; you can call them whatever you like,
  and as with other LIT components multiple segments are supported.
    Output:
      - Embeddings (`emb_layer`) to return the input embeddings
          for a layer
      - Gradients (`grad_layer`) to return the gradients w.r.t.
          `emb_layer`
      - Gradients class (`grad_class`) to return the label that gradients
        were computed for. This is usually a CategoryLabel, but can be anything
        since it will just be fed back into the model.
      - MulticlassPreds (`probas`)
  """

  def create_comparison_splits(self, dataset_examples, ids_set,
                               num_splits=NUM_SPLITS):
    """Creates randomly sampled splits for multiple TCAV runs."""
    splits = []

    # Exclude concept_set examples.
    filtered_examples = list(filter(lambda ex: ex['id'] not in ids_set,
                                    dataset_examples))

    for _ in range(num_splits):
      splits.append(random.sample(filtered_examples, len(ids_set)))
    return splits

  def hyp_test(self, scores):
    """Returns the p-value for a two-sided t-test on the TCAV score."""
    # The null hypothesis is 0.5, since a TCAV score of 0.5 would indicate
    # the concept does not affect the prediction positively or negatively.
    _, p_val = scipy.stats.ttest_1samp(scores, 0.5)
    return p_val

  def run_with_metadata(
      self,
      indexed_inputs: List[JsonDict],
      model: lit_model.Model,
      dataset: lit_dataset.Dataset,
      model_outputs: Optional[List[JsonDict]] = None,
      config: Optional[JsonDict] = None) -> Optional[List[JsonDict]]:
    """Runs the TCAV method given the params in the inputs and config.

    Args:
      indexed_inputs: all examples in the dataset, in the indexed input format.
      model: the model being explained.
      dataset: the dataset which the current examples belong to.
      model_outputs: optional model outputs from calling model.predict(inputs).
      config: a config which should specify:
        {
          'concept_set_ids': [list of ids to use in concept set]
          'class_to_explain': [gradient class to explain],
          'grad_layer': [the Gradient field key of the layer to explain],
          'random_state': [an optional seed to make outputs deterministic]
        }

    Returns:
      A JsonDict containing the TCAV scores, directional derivatives,
      statistical test p-values, and LM accuracies.
    """
    config = TCAVConfig(**config)
    # TODO(b/171513556): get these from the Dataset object once indices are
    # available there.
    dataset_examples = indexed_inputs

    # Get this layer's output spec keys for gradients and embeddings.
    grad_layer = config.grad_layer
    output_spec = model.output_spec()
    emb_layer = cast(types.Gradients, output_spec[grad_layer]).grad_for

    # Get the class that the gradients were computed for.
    grad_class_key = cast(types.Gradients, output_spec[grad_layer]).grad_target

    ids_set = set(config.concept_set_ids)
    concept_set = [ex for ex in dataset_examples if ex['id'] in ids_set]

    # Get outputs using model.predict().
    concept_outputs = list(model.predict_with_metadata(concept_set))
    dataset_outputs = list(model.predict_with_metadata(dataset_examples))

    # Create random splits of the dataset to use as comparison sets.
    splits = self.create_comparison_splits(dataset_examples, ids_set)

    # Call run_tcav() on each comparison set.
    concept_results = []
    for comparison_set in splits:
      comparison_outputs = list(model.predict_with_metadata(comparison_set))
      concept_results.append(
          self._run_tcav(concept_outputs, comparison_outputs, dataset_outputs,
                         config.class_to_explain, emb_layer, grad_layer,
                         grad_class_key, config.test_size,
                         config.random_state))

    cav_scores = [res['score'] for res in concept_results]
    p_val = self.hyp_test(cav_scores)

    # Get index of CAV result with the highest accuracy.
    accuracies = [res['accuracy'] for res in concept_results]
    index = np.argmax(accuracies)

    # Many CAVS are trained and checked for statistical testing to calculate
    # the p-value. The values of the first CAV are returned.
    results = {'result': concept_results[index], 'p_val': p_val}
    return [results]

  def _get_training_data(self, comparison_outputs, concept_outputs, emb_layer):
    """Formats activations from model outputs as training data for the LM."""
    x = np.concatenate([[o[emb_layer] for o in comparison_outputs],
                        [o[emb_layer] for o in concept_outputs]])
    y = np.concatenate([np.zeros(len(comparison_outputs)),
                        np.ones(len(concept_outputs))])
    return x, y

  def _run_tcav(self, concept_outputs: List[JsonDict],
                comparison_outputs: List[JsonDict],
                dataset_outputs: List[JsonDict], class_to_explain: Any,
                emb_layer: Text, grad_layer: Text, grad_class_key: Text,
                test_size: float, random_state=None):
    """Returns directional derivatives, tcav score, and LM accuracy."""
    x, y = self._get_training_data(comparison_outputs, concept_outputs,
                                   emb_layer)
    # Get CAV vector and accuracy of the trained linear model.
    cav, accuracy = self.get_trained_cav(x, y, test_size, random_state)

    # Compute directional derivatives for class to explain.
    dir_derivs = self.get_dir_derivs(
        cav, dataset_outputs, grad_layer, grad_class_key,
        class_to_explain)

    # Calculate the TCAV score using the gradient class directional derivatives.
    tcav_score = self.compute_tcav_score(dir_derivs)

    # Compute cosine similarity and dot product between CAV and activations.
    cos_sim, dot_prods = self.compute_local_scores(cav, dataset_outputs,
                                                   emb_layer)

    return {'score': tcav_score, 'cos_sim': cos_sim, 'dot_prods': dot_prods,
            'accuracy': accuracy}

  def get_trained_cav(self, x, y, test_size, random_state=None):
    """Trains linear model on activations, returns weights (CAV) and accuracy."""
    x_train, x_test, y_train, y_test = sklearn.model_selection.train_test_split(
        x, y, test_size=test_size, stratify=y, random_state=random_state)

    # Train linear model on training set.
    # TODO(b/177005822): Include additional linear classifier options
    # (e.g. L-BFGS, logistic regression, etc.)
    lm = sklearn.linear_model.SGDClassifier(random_state=random_state)
    lm.fit(x_train, y_train)
    cav = lm.coef_  # the weights of the LM are the CAV.

    # Compute accuracy on test set.
    y_pred = lm.predict(x_test)
    correct_count = 0
    for pred_val, test_val in zip(y_pred, y_test):
      if pred_val == test_val:
        correct_count += 1
    accuracy = correct_count / len(y_test)

    return cav, accuracy

  def get_dir_derivs(self, cav, dataset_outputs, grad_layer, grad_class_key,
                     class_to_explain):
    """Returns directional derivatives for class_to_explain examples."""
    dir_derivs = []

    for o in dataset_outputs:
      if o[grad_class_key] == class_to_explain:
        grad = o[grad_layer]
        # Multiplies the dataset_outputs’ gradients with the model’s weights
        # to get the directional derivative.
        dir_deriv = np.dot(grad, cav.flatten())
        dir_derivs.append(dir_deriv)
    return dir_derivs

  def compute_tcav_score(self, dir_derivs):
    """Returns the tcav score given the class to explain directional derivs."""
    # Maps positive derivatives to 1 and non-positive derivatives to 0.
    positive_dirs = [int(dir > 0) for dir in dir_derivs]

    # Divides the number of examples in the class_to_explain with directional
    # derivative > 0 by the total number of examples in the class_to_explain
    # to compute TCAV score.
    num_positive_dirs = sum(positive_dirs)
    return num_positive_dirs / len(dir_derivs)

  def compute_local_scores(self, cav, dataset_outputs, emb_layer):
    """Compute cosine similarity and dot product between CAV and activations."""
    flattened_cav = cav.flatten()
    dot_prods = [np.dot(flattened_cav, o[emb_layer]) for o in dataset_outputs]

    cav_magnitude = np.linalg.norm(flattened_cav)
    emb_magnitudes = [np.linalg.norm(o[emb_layer]) for o in dataset_outputs]
    cos_sim = [dot_prod / (emb_magnitude * cav_magnitude) for dot_prod,
               emb_magnitude in zip(dot_prods, emb_magnitudes)]
    return cos_sim, dot_prods
